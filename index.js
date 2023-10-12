const fs = require("fs");
const currency = require("currency.js");
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray");
const { format: dateFormat, parseISO } = require("date-fns");

const mappedCoins = {
  "ibc/2181AAB0218EAC24BC9F86BD1364FBBFA3E6E3FCC25E88E3E68C15DC6E752D86":
    "uakt",
  "ibc/68A333688E5B07451F95555F8FE510E43EF9D3D44DF0909964F92081EF9BE5A7":
    "uiov",
  "ibc/42E47A5BA708EBE6E0C227006254F2784E209F4DBD3C6BB77EDC4B29EF875E8E":
    "udpvn",
  "ibc/14F9BC3E44B8A9C1BE1FB08980FAB87034C9905EF17CF2F5008FC085218811CC":
    "uosmo",
};

const denom = {
  uatom: 1_000_000,
};

function getMsg(msg) {
  return msg[msg["@type"].replaceAll(".", "-")];
}

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
    let date = "",
      type = "",
      sentAsset = "",
      sentAmount = "",
      receivedAsset = "",
      receivedAmount = "",
      feeAsset = "ATOM",
      feeAmount = "",
      marketValueCurrency = "USD",
      marketValue = "",
      description = "",
      transactionHash = "",
      transactionId = "";

    const { txhash, timestamp, id, tx, logs } = value;

    date = dateFormat(parseISO(timestamp), "yyyy-MM-dd H:mm:ss");
    transactionHash = txhash;
    transactionId = id;

    const { body, auth_info } = tx[tx["@type"].replaceAll(".", "-")];

    const fee = auth_info.fee.amount[0];
    const denominator = denom[auth_info.fee.amount[0].denom];
    feeAmount = currency(fee.amount, { precision: 8 }).divide(
      denominator
    ).value;

    if (body) {
      for (const msg of body.messages) {
        const msgType = msg["@type"];
        msgs.add(msgType);
        const msgObj = getMsg(msg);

        if (msgType === "/cosmos.gov.v1beta1.MsgVote") {
          const proposalId = msgObj.proposal_id;
          type = "Expense";
          description = `Vote on Proposal #${proposalId}`;
        }

        if (msgType === "/cosmos.staking.v1beta1.MsgDelegate") {
          // console.log(msg);
        }

        if (
          msgType === "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward"
        ) {
          // console.log(msg);
        }

        if (msgType === "/cosmos.staking.v1beta1.MsgBeginRedelegate") {
          type = "Expense";
          description = `Redelegate ${
            currency(msgObj.amount.amount, {
              precision: 8,
            }).divide(denom.uatom).value
          } ATOMS`;
        }

        if (msgType === "/ibc.core.client.v1.MsgUpdateClient") {
          // console.log(msg);
        }

        if (msgType === "/tendermint.liquidity.v1beta1.MsgSwapWithinBatch") {
          const coin = currency(msgObj.offer_coin.amount, {
            precision: 8,
          }).divide(denom.uatom);

          const swap = coin.multiply(msgObj.order_price);

          console.log({
            atom: coin.value,
            swap: swap.value,
            wanted_coin: mappedCoins[msgObj.demand_coin_denom],
            order_price: msgObj.order_price,
          });
        }

        if (msgType === "/tendermint.liquidity.v1beta1.MsgDepositWithinBatch") {
          // console.log(JSON.stringify(body.messages, null, 2));
          // for (const log of logs) {
          //   for (const evt of log.events) {
          //     console.log(evt);
          //   }
          // }
        }

        if (
          msgType === "/tendermint.liquidity.v1beta1.MsgWithdrawWithinBatch"
        ) {
          // console.log(msg);
        }
      }
    }

    // console.log(">>> MESSAGES: ", JSON.stringify(body.messages, null, 2));
    // for (const log of logs) {
    //   const { events } = log;
    //   console.log(">>>> EVENTS: ", JSON.stringify(events, null, 2));
    // }
    return (
      [
        date,
        type,
        sentAsset,
        sentAmount,
        receivedAsset,
        receivedAmount,
        feeAsset,
        feeAmount,
        marketValueCurrency,
        marketValue,
        description,
        transactionHash,
        transactionId,
      ].join(",") + ",\n"
    );
  },
  fs.createWriteStream("data.csv", { flags: "a" }),
]);

pipeline.on("end", () => {
  console.log(msgs.values());
});
