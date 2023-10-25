import fs from "fs";
import { chain } from "stream-chain";
import { parser } from "stream-json";
import { streamArray } from "stream-json/streamers/StreamArray";
import csvParser from "csv-parser";
import { stringify as csvStringify } from "csv-stringify/sync";
import processTransaction from "./processTransaction.ts";
import { assets } from "chain-registry";
import { parseISO, format as dateFormat, compareDesc } from "date-fns";
import { getBalanceSheet } from "./utils/getBalanceSheet.ts";

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
  const timeoutFilename = `${network}_timeout_txs.txt`;

  chain([
    fs.createReadStream("./headers/koinly.txt"),
    (data) => {
      return data.toString() + "\n";
    },
    fs.createWriteStream(csvFilename),
  ]);

  let txCount = 0;
  const pipeline = chain([
    fs.createReadStream(`./data/${network}.json`),
    parser(),
    streamArray(),
    async (data) => {
      txCount++;
      const transactions: string[] = [];
      const transaction = data.value;
      const mainTx = await processTransaction(
        network,
        symbol,
        decimals,
        address,
        transaction
      );
      transactions.push(mainTx);
      return transactions.join("");
    },
    fs.createWriteStream(csvFilename, { flags: "a" }),
  ]);

  pipeline.on("end", async () => {
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

        if (network === "osmosis") {
          const records: Array<Record<string, string>> = [];

          fs.createReadStream(`./csv/${network}_data.csv`)
            .pipe(csvParser())
            .on("data", (data) => {
              records.push(data);
            })
            .on("end", async () => {
              // map over records and insert rewards
              const data = await fs.promises.readFile(
                `./network-rewards/${network}_rewards.json`
              );
              if (!data) {
                const getRewards = await import(
                  `./network-rewards/${network}`
                ).then(({ getRewards }) => getRewards);
                const rewards = await getRewards(address);
                for (const token in rewards) {
                  const rewardsArray = rewards[token];
                  for (const { amount, day } of rewardsArray) {
                    if (amount) {
                      records.push({
                        Date: dateFormat(parseISO(day), "yyyy-MM-dd HH:mm:ss"),
                        "Received Amount": amount,
                        "Received Currency": token,
                        Description: "Received Liquidity Rewards",
                        Label: "Income",
                        "Sent Amount": "",
                        "Sent Currency": "",
                        "Fee Amount": "",
                        "Fee Currency": "",
                        "Net Worth Amount": "",
                        "Net Worth Currency": "",
                        TxHash: "",
                        TxId: "",
                        Meta: "",
                      });
                    }
                  }
                }

                records.sort((a, b) =>
                  compareDesc(parseISO(a.Date), parseISO(b.Date))
                );

                const headers = Object.keys(records[0]).reduce((acc, key) => {
                  acc[key] = key;
                  return acc;
                }, {} as (typeof records)[number]);
                records.unshift(headers);
                const csv = csvStringify(records);
                await fs.promises
                  .writeFile(`./csv/${network}_data.csv`, csv)
                  .then(() => {
                    getBalanceSheet(network);
                  });
                return;
              }

              const rewardsData = JSON.parse(data.toString());
              for (const token in rewardsData) {
                const rewards = rewardsData[token];
                for (const { amount, day } of rewards) {
                  if (amount) {
                    records.push({
                      Date: dateFormat(parseISO(day), "yyyy-MM-dd HH:mm:ss"),
                      "Received Amount": amount,
                      "Received Currency": token,
                      Description: "Received Liquidity Rewards",
                      Label: "Income",
                      "Sent Amount": "",
                      "Sent Currency": "",
                      "Fee Amount": "",
                      "Fee Currency": "",
                      "Net Worth Amount": "",
                      "Net Worth Currency": "",
                      TxHash: "",
                      TxId: "",
                      Meta: "",
                    });
                  }
                }
              }
              records.sort((a, b) =>
                compareDesc(parseISO(a.Date), parseISO(b.Date))
              );
              const headers = Object.keys(records[0]).reduce((acc, key) => {
                acc[key] = key;
                return acc;
              }, {} as (typeof records)[number]);
              records.unshift(headers);
              const csv = csvStringify(records);
              await fs.promises
                .writeFile(`./csv/${network}_data.csv`, csv)
                .then(() => {
                  getBalanceSheet(network);
                });
            });
        } else {
          getBalanceSheet(network);
        }
      });
  });
}

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
