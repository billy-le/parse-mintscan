const fs = require("fs");
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray");
const { format: dateFormat, parseISO } = require("date-fns");

const currency = require("currency.js");

const denom = {
  uatom: 100_000,
};

const types = {
  "/cosmos.gov.v1beta1.MsgVote": "Expense",
  "/cosmos.staking.v1beta1.MsgDelegate": "Expense",
  "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward": "Staking",
  "/cosmos.staking.v1beta1.MsgBeginRedelegate": "Expense",
  "/ibc.core.client.v1.MsgUpdateClient": "",
  "/ibc.core.channel.v1.MsgAcknowledgement": "",
  "/ibc.applications.transfer.v1.MsgTransfer": "Transfer",
  "/ibc.core.channel.v1.MsgRecvPacket": "",
  "/cosmos.bank.v1beta1.MsgSend": "Deposit",
  "/ibc.core.channel.v1.MsgTimeout": "Expense",
  "/tendermint.liquidity.v1beta1.MsgSwapWithinBatch": "Staking",
  "/tendermint.liquidity.v1beta1.MsgWithdrawWithinBatch": "Staking",
  "/tendermint.liquidity.v1beta1.MsgDepositWithinBatch": "Expense",
};

chain([
  fs.createReadStream("headers.txt"),
  (data) => {
    return data.toString();
  },
  fs.createWriteStream("data.csv"),
]);

const msgs = new Set();

const pipeline = chain([
  fs.createReadStream("cosmos.json"),
  parser(),
  streamArray(),
  (data) => {
    const value = data.value;
    const { txhash, timestamp, id, tx, logs } = value;

    const { body, auth_info } = tx[tx["@type"].replaceAll(".", "-")];

    const fee = auth_info.fee.amount[0];
    const denominator = denom[auth_info.fee.amount[0].denom];
    const feeAmount = currency(fee.amount, { precision: 8 }).divide(
      denominator
    ).value;
    for (const t in tx) {
      if (tx[t]?.body) {
        for (const msg of tx[t].body.messages) {
          msgs.add(msg["@type"]);
        }
      }
    }

    for (const log of logs) {
      const { events } = log;
      console.log(events);
      for (const event of events) {
        console.log(event.attributes);
      }
    }
    return (
      [
        dateFormat(parseISO(timestamp), "yyyy-MM-dd H:mm:ss"), // Date
        "", // Type
        "", // Sent Asset
        "", // Sent Amount
        "", // Received Asset
        "", // Received Amount
        "ATOM", // Fee Asset
        feeAmount, // Fee Amount
        "USD", // Market Value Currency
        "", // Market Value
        "", // Description
        txhash, // Transaction Hash
        id, // Transaction ID
      ].join(",") + ",\n"
    );
  },
  fs.createWriteStream("data.csv", { flags: "a" }),
]);

pipeline.on("end", () => {
  console.log(msgs.values());
});
