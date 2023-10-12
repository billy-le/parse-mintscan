const fs = require("fs");
const processTransaction = require("./processTransaction.js");
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray");

const mappedCoins = {
  "ibc/2181AAB0218EAC24BC9F86BD1364FBBFA3E6E3FCC25E88E3E68C15DC6E752D86": "AKT",
  "ibc/68A333688E5B07451F95555F8FE510E43EF9D3D44DF0909964F92081EF9BE5A7": "IOV",
  "ibc/42E47A5BA708EBE6E0C227006254F2784E209F4DBD3C6BB77EDC4B29EF875E8E":
    "DPVN",
  "ibc/14F9BC3E44B8A9C1BE1FB08980FAB87034C9905EF17CF2F5008FC085218811CC":
    "OSMO",
  uatom: "ATOM",
};

chain([
  fs.createReadStream("headers.txt"),
  (data) => {
    return data.toString();
  },
  fs.createWriteStream("data.csv"),
]);

const pipeline = chain([
  fs.createReadStream("cosmos.json"),
  parser(),
  streamArray(),
  async (data) => {
    const transactions = [];
    const transaction = data.value;
    const mainTx = await processTransaction(process.argv[2], transaction);
    transactions.push(mainTx);

    return transactions.map((tx) => tx.join(",") + ",\n");
  },
  fs.createWriteStream("data.csv", { flags: "a" }),
]);

pipeline.on("end", () => {
  console.log("data.csv created");
});
