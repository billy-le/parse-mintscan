const currency = require("currency.js");
const { format: dateFormat, parseISO } = require("date-fns");

const denom = {
  uatom: 1_000_000,
};

function getModuleType(mod) {
  return mod[mod["@type"].replaceAll(".", "-")];
}

function processTransaction(address, { txhash, timestamp, id, tx, logs }) {
  let date = dateFormat(parseISO(timestamp), "yyyy-MM-dd H:mm:ss"),
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
    transactionHash = txhash,
    transactionId = id;

  const { body, auth_info } = getModuleType(tx);
  const fee = auth_info.fee.amount[0];
  const denominator = denom[auth_info.fee.amount[0].denom];
  feeAmount = currency(fee.amount, { precision: 8 }).divide(denominator).value;
  const _logs = [...logs];
  while (_logs.length > 0) {
    const log = _logs.shift();
    const events = [...log.events];
    const messageLog = events.splice(
      events.findIndex((log) => log.type === "message"),
      1
    )[0];

    const moduleAttr = messageLog.attributes.find(
      (attr) => attr.key === "module"
    );

    switch (moduleAttr.value) {
      case "bank": {
        while (events.length > 0) {
          const event = events.shift();
          const attributes = [...event.attributes];
          if (event.type === "transfer") {
            if (
              attributes.find(
                (attr) => attr.key === "recipient" && attr.value === address
              )
            ) {
              const coin = attributes.find((attr) => attr.key === "amount");
              if (coin.value.includes("uatom")) {
                const [amount] = coin.value.split("uatom");
                const atom = currency(amount, { precision: 8 }).divide(
                  1_000_000
                ).value;
                type = "Deposit";
                receivedAsset = "ATOM";
                receivedAmount = atom;
              } else if (coin.value.includes("ibc/")) {
                const [amount, pathHash] = coin.value.split("ibc/");
                const cu = currency(amount, { precision: 8 }).divide(
                  1_000_000
                ).value;
                type = "Airdrop";
                receivedAsset = "BTSG";
                receivedAmount = cu;
              }
            }
          }
        }
        break;
      }
      case "distribution": {
        break;
      }
      case "governance": {
        break;
      }
      case "staking": {
        break;
      }
      case "liquidity": {
        break;
      }
      case "ibc_channel": {
        break;
      }
      case "ibc_client": {
        break;
      }
      default: {
        console.log(moduleAttr.value);
        break;
      }
    }
  }

  return [
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
  ];
}

module.exports = processTransaction;
