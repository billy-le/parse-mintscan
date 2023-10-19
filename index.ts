import fs from "fs";
import { chain } from "stream-chain";
import { parser } from "stream-json";
import { streamArray } from "stream-json/streamers/StreamArray";
import csvParser from "csv-parser";
import { stringify as csvStringify } from "csv-stringify/sync";
import processTransaction from "./processTransaction.ts";
import bigDecimal from "js-big-decimal";
const walletAddress = process.argv[2];
if (!walletAddress) throw new Error("no wallet provided as argument");

const network = "evmos";
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
    const mainTx = await processTransaction(walletAddress, transaction);
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
  console.log(msgTypes);
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
        { sent: string; received: string; fees: string }
      > = {};

      fs.createReadStream(`./csv/${network}_data.csv`)
        .pipe(csvParser())
        .on("data", (data) => {
          const date = data.Date;
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
              };
            }

            balanceSheet[sentAsset] = {
              ...balanceSheet[sentAsset],
              sent: bigDecimal.add(balanceSheet?.[sentAsset].sent, sentAmount),
            };
          }

          if (feeAsset) {
            if (!balanceSheet[feeAsset]) {
              balanceSheet[feeAsset] = {
                sent: "0",
                fees: "0",
                received: "0",
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
        })
        .on("end", () => {
          console.log("Your balance is:");
          console.log(balanceSheet);
        });
    });
});
