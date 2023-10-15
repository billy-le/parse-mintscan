const fs = require("fs");
const processTransaction = require("./processTransaction.js");
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray");
const csvParser = require("csv-parser");
const csvStringify = require("csv-stringify/sync");

const walletAddress = process.argv[2];
if (!walletAddress) throw new Error("no wallet provided as argument");

chain([
  fs.createReadStream("headers.txt"),
  (data) => {
    return data.toString();
  },
  fs.createWriteStream("data.csv"),
]);

const msgTypes = new Set();

let txCount = 0;
const pipeline = chain([
  fs.createReadStream("cosmos.json"),
  parser(),
  streamArray(),
  async (data) => {
    txCount++;
    const transactions = [];
    const transaction = data.value;
    const mainTx = await processTransaction(walletAddress, transaction);
    const tx = transaction.tx[transaction.tx["@type"].replaceAll(".", "-")];
    tx.body.messages.forEach((msg) => {
      msgTypes.add(msg["@type"]);
    });
    transactions.push(mainTx);
    return transactions.join("");
  },
  fs.createWriteStream("data.csv", { flags: "a" }),
]);

pipeline.on("end", async () => {
  console.log("data.csv created", `\nprocessed ${txCount} transactions`);

  // remove txs from timeouts and meta from csv
  let records = [];
  fs.createReadStream("data.csv")
    .pipe(csvParser())
    .on("data", (data) => {
      try {
        const timeoutData = fs.readFileSync("timeout_txs.txt");
        const timeouts = timeoutData.toString().split("\n");

        if (!data.Meta || !timeouts.includes(data.Meta)) {
          delete data.Meta;
          records.push(data);
        }
      } catch (err) {
        console.log("no timeout txs found!");
      }
    })
    .on("end", () => {
      if (records.length) {
        const headers = Object.keys(records[0]).reduce((acc, key) => {
          acc[key] = key;
          return acc;
        }, {});
        records.unshift(headers);
        const output = csvStringify.stringify(records);
        fs.writeFileSync("data.csv", output);
      }

      // delete timeout file silently
      fs.unlink("timeout_txs.txt", (err) => {
        if (err) return;
      });
    });
});
