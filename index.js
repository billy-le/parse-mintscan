const fs = require("fs");
const processTransaction = require("./processTransaction.js");
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray");

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

const pipeline = chain([
  fs.createReadStream("cosmos.json"),
  parser(),
  streamArray(),
  async (data) => {
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

pipeline.on("end", () => {
  console.log(msgTypes.values());
  console.log("data.csv created");
});
