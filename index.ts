import fs from "fs";
import { chain } from "stream-chain";
import { parser } from "stream-json";
import { streamArray } from "stream-json/streamers/StreamArray";
import csvParser from "csv-parser";
import { stringify as csvStringify } from "csv-stringify/sync";
import processTransaction from "./processTransaction.ts";
import bigDecimal from "js-big-decimal";
import { chains, assets } from "chain-registry";

const networks = process.argv.slice(2);
if (!networks.length) throw new Error("no network=wallet provided as argument");

for (const network of networks) {
  const [chain, address] = network.split("=");
  if (!chain || !address) {
    throw new Error("chain=address not valid");
  }
  const chainInfo = assets.find(({ chain_name }) => chain === chain_name);
  if (!chainInfo) throw new Error("network name not found");

  const asset = chainInfo.assets[0];
  const symbol = asset.symbol;
  const decimals = asset.denom_units.find(
    (unit) => unit.denom === asset.display
  )?.exponent;
  if (!decimals) throw new Error("decimals not found");

  await main({ network: chain, address, symbol, decimals });
}

async function main({
  network,
  address,
  symbol,
  decimals,
}: {
  network: string;
  address: string;
  symbol: string;
  decimals: number;
}) {
  const csvFilename = `./csv/${network}_data.csv`;
  const timeoutFilename = "timeout_txs.txt";

  chain([
    fs.createReadStream("./headers/koinly.txt"),
    (data) => {
      return data.toString() + "\n";
    },
    fs.createWriteStream(csvFilename),
  ]);

  const msgTypes = new Set<string>();

  let txCount = 0;
  const pipeline = chain([
    fs.createReadStream(`./data/${network}.json`),
    parser(),
    streamArray(),
    async (data) => {
      txCount++;
      const transactions = [];
      const transaction = data.value;
      const mainTx = await processTransaction(
        symbol,
        decimals,
        address,
        transaction
      );
      const tx = transaction.tx[transaction.tx["@type"].replaceAll(".", "-")];
      tx.body.messages.forEach((msg: Record<string, any>) => {
        msgTypes.add(msg["@type"]);
      });
      transactions.push(mainTx);
      return transactions.join("");
    },
    fs.createWriteStream(csvFilename, { flags: "a" }),
  ]);

  pipeline.on("end", async () => {
    // console.log(msgTypes);
    console.log("data.csv created", `\nprocessed ${txCount} transactions`);

    // remove txs from timeouts and meta from csv
    let records: Array<Record<string, string>> = [];
    fs.createReadStream(csvFilename)
      .pipe(csvParser())
      .on("data", (data) => {
        try {
          const timeoutData = fs.readFileSync(timeoutFilename);
          const timeouts = timeoutData.toString().split("\n");

          if (!data.Meta || !timeouts.includes(data.Meta)) {
            delete data.Meta;
            records.push(data);
          }
        } catch (err) {}
      })
      .on("end", () => {
        if (records.length) {
          const headers = Object.keys(records[0]).reduce((acc, key) => {
            acc[key] = key;
            return acc;
          }, {} as (typeof records)[number]);
          records.unshift(headers);
          const output = csvStringify(records);
          fs.writeFileSync(csvFilename, output);
        } else {
          console.log("no timeout txs found!");
        }

        // delete timeout file silently
        fs.unlink(timeoutFilename, (err) => {
          if (err) return;
        });

        const balanceSheet: Record<
          string,
          {
            sent: string;
            received: string;
            fees: string;
            endingBalance: string;
          }
        > = {};

        fs.createReadStream(`./csv/${network}_data.csv`)
          .pipe(csvParser())
          .on("data", (data) => {
            const sentAsset = data["Sent Currency"];
            const sentAmount = data["Sent Amount"];
            const receivedAmount = data["Received Amount"];
            const receivedAsset = data["Received Currency"];
            const feeAmount = data["Fee Amount"];
            const feeAsset = data["Fee Currency"];

            if (sentAsset) {
              if (!balanceSheet[sentAsset]) {
                balanceSheet[sentAsset] = {
                  sent: "0",
                  fees: "0",
                  received: "0",
                  endingBalance: "0",
                };
              }

              balanceSheet[sentAsset] = {
                ...balanceSheet[sentAsset],
                sent: bigDecimal.add(
                  balanceSheet?.[sentAsset].sent,
                  sentAmount
                ),
              };
            }

            if (feeAsset) {
              if (!balanceSheet[feeAsset]) {
                balanceSheet[feeAsset] = {
                  sent: "0",
                  fees: "0",
                  received: "0",
                  endingBalance: "0",
                };
              }

              balanceSheet[feeAsset] = {
                ...balanceSheet[feeAsset],
                fees: bigDecimal.add(balanceSheet?.[feeAsset].fees, feeAmount),
              };
            }

            if (receivedAsset) {
              if (!balanceSheet[receivedAsset]) {
                balanceSheet[receivedAsset] = {
                  sent: "0",
                  fees: "0",
                  received: "0",
                  endingBalance: "0",
                };
              }

              balanceSheet[receivedAsset] = {
                ...balanceSheet[receivedAsset],
                received: bigDecimal.add(
                  balanceSheet?.[receivedAsset].received,
                  receivedAmount
                ),
              };
            }

            for (const token in balanceSheet) {
              const tokenMeta = balanceSheet[token];
              const outflow = bigDecimal.add(tokenMeta.sent, tokenMeta.fees);
              balanceSheet[token].endingBalance = bigDecimal.subtract(
                tokenMeta.received,
                outflow
              );
            }
          })
          .on("end", () => {
            console.log("Your balance is:");
            console.log(balanceSheet);
          });
      });
  });
}
