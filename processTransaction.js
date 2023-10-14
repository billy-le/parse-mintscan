const fs = require("fs");
const util = require("util");
const currency = require("currency.js");
const { exec } = require("child_process");
const { format: dateFormat, parseISO } = require("date-fns");
const csvParser = require("csv-parser");
const { stringify: csvStringify } = require("csv-stringify/sync");

const execPromise = util.promisify(exec);
const denominator = 1_000_000;

function getModuleType(mod) {
  return mod[mod["@type"].replaceAll(".", "-")];
}

async function getIbcDenomination(pathHash) {
  if (!pathHash) throw new Error("pathHash not provided");
  const filePath = "./ibc-denominations.json";
  try {
    const file = await fs.promises.readFile(filePath);
    const ibcDenominations = JSON.parse(file.toString());

    if (ibcDenominations[pathHash]) {
      return ibcDenominations[pathHash];
    }
    const { stdout, stderr } = await execPromise(
      `$GOPATH/bin/gaiad query ibc-transfer denom-trace ${pathHash} --node https://cosmos-rpc.quickapi.com:443`
    );
    if (stderr) {
      throw new Error(stderr);
    }
    const token = stdout
      .split("\n")
      .find((part) => part.includes("base_denom"))
      .replaceAll(/base_denom:/gi, "")
      .replaceAll(" ", "");

    ibcDenominations[pathHash] = token;

    await fs.promises.writeFile(
      filePath,
      JSON.stringify(ibcDenominations, null, 2)
    );
    return token;
  } catch (err) {
    console.log(err);
    return "Unknown";
  }
}

function createTransaction({
  date,
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
  transactionId = "",
  meta = "",
}) {
  return {
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
    meta,
  };
}

function getFees(tx) {
  const { auth_info } = getModuleType(tx);
  const fee = auth_info.fee.amount[0];
  return currency(fee.amount, { precision: 8 }).divide(denominator).value;
}

async function processTransaction(
  address,
  { txhash: transactionHash, id: transactionId, timestamp, tx, logs }
) {
  const date = dateFormat(parseISO(timestamp), "yyyy-MM-dd H:mm:ss");

  let transactions = [];

  const { body } = getModuleType(tx);

  const msgTypeGroup = {};

  body.messages.forEach((message) => {
    const msgType = message["@type"];
    if (!msgTypeGroup[msgType]) {
      msgTypeGroup[msgType] = [];
    }
    const msg = getModuleType(message);
    msgTypeGroup[msgType].push(msg);
  });

  let processed = false;

  // if there are no logs, usually means transaction has failed
  if (!logs.length) {
    processed = true;
    transactions.push(
      createTransaction({
        date,
        transactionHash,
        transactionId,
        feeAmount: getFees(tx),
        type: "Expense",
        description: "Transaction Failed",
      })
    );
  } else {
    for (const type in msgTypeGroup) {
      switch (type) {
        case "/cosmos.gov.v1beta1.MsgVote": {
          processed = true;

          let proposals = [];
          for (const msg of msgTypeGroup[type]) {
            proposals.push("#" + msg.proposal_id);
          }

          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: `Vote on ${proposals.join(" ")}`,
              feeAmount: getFees(tx),
            })
          );
          break;
        }

        case "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward": {
          processed = true;
          const tokens = {};
          for (const log of logs) {
            for (const event of log.events) {
              if (event.type == "withdraw_rewards") {
                const attr = event.attributes.find(
                  (attr) => attr.key === "amount"
                );

                const values = attr.value.split(",");

                for (const value of values) {
                  if (value.includes("uatom")) {
                    if (!tokens["atom"]) {
                      tokens["atom"] = currency(0, { precision: 8 });
                    }
                    const [atomValue] = value.split("uatom");
                    tokens["atom"] = tokens["atom"].add(
                      currency(atomValue, { precision: 8 }).divide(denominator)
                    );
                  } else {
                    const [amount, pathHash] = value.split("ibc/");
                    const token = await getIbcDenomination(pathHash);
                    if (!tokens[token]) {
                      tokens[token] = currency(0, { precision: 8 });
                    }
                    tokens[token] = tokens[token].add(
                      currency(amount, { precision: 8 }).divide(denominator)
                    );
                  }
                }
              }
            }
          }

          for (const token in tokens) {
            transactions.push(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                receivedAsset: token.toUpperCase(),
                receivedAmount: tokens[token].value,
                description: "Claim Rewards",
                type: "Staking",
                feeAsset: "",
              })
            );
          }
          break;
        }
        case "/cosmos.staking.v1beta1.MsgDelegate": {
          processed = true;
          let delegatedAmount = currency(0, { precision: 8 });
          const data = msgTypeGroup[type];
          for (const d of data) {
            delegatedAmount = delegatedAmount.add(d.amount.amount);
          }
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: `Delegated ${
                delegatedAmount.divide(denominator).value
              } ATOM`,
              feeAmount: getFees(tx),
            })
          );

          break;
        }
        case "/cosmos.staking.v1beta1.MsgBeginRedelegate": {
          processed = true;
          let redelagation = currency(0, { precision: 8 });
          msgTypeGroup[type].forEach((msg) => {
            const amount = currency(msg.amount.amount, { precision: 8 }).divide(
              denominator
            );
            redelagation = redelagation.add(amount);
          });
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              description: `Redelegate ${redelagation.value} ATOM`,
              type: "Other",
              feeAmount: getFees(tx),
            })
          );
          break;
        }
        case "/ibc.applications.transfer.v1.MsgTransfer": {
          processed = true;
          const messages = msgTypeGroup[type];
          for (const msg of messages) {
            const {
              token: { amount, denom },
              sender,
              receiver,
              timeout_height: { revision_number, revision_height },
            } = msg;
            const tokens = denom.split(",");
            const transferAmount = currency(amount, { precision: 6 }).divide(
              denominator
            ).value;
            const transaction = createTransaction({
              date,
              transactionHash,
              transactionId,
              feeAmount: getFees(tx),
              type: "Transfer",
              meta: `timeout_height: ${revision_number}_${revision_height}`,
            });
            for (const _token of tokens) {
              const token = await getIbcDenomination(_token);
              if (sender === address) {
                transaction.sentAmount = transferAmount;
                transaction.sentAsset = token;
              } else if (receiver === address) {
                transaction.receivedAmount = transferAmount;
                transaction.receivedAsset = token;
              }
              transactions.push(transaction);
            }
          }
          break;
        }
        case "/ibc.core.client.v1.MsgUpdateClient": {
          // MsgUpdateClient usually processed with MsgAcknowledgement, MsgRecvPacket, MsgTimeout

          for (const msgType in msgTypeGroup) {
            switch (msgType) {
              case "/ibc.core.channel.v1.MsgAcknowledgement": {
                // not used by end consumer
                break;
              }
              case "/ibc.core.channel.v1.MsgTimeout": {
                processed = true;
                for (const msg of msgTypeGroup[msgType]) {
                  const {
                    packet: {
                      timeout_height: { revision_number, revision_height },
                    },
                  } = msg;
                  // when an ibc transaction timeouts, we need to remove the entry from the data.csv
                  const readStream = fs.createReadStream("data.csv", "utf-8");
                  let records = [];
                  readStream
                    .pipe(
                      csvParser({
                        headers: true,
                      })
                    )
                    .on("data", (data) => {
                      if (
                        data.Meta !==
                        `timeout_height: ${revision_number}_${revision_height}`
                      ) {
                        records.push(data);
                      } else {
                        console.log(data);
                      }
                    })
                    .on("end", () => {
                      const writeStream = fs.createWriteStream("data.csv");
                      writeStream.write(csvStringify(records));
                      writeStream.end();
                    });
                }
                break;
              }
              case "/ibc.core.channel.v1.MsgRecvPacket": {
                processed = true;

                const msgPackets = msgTypeGroup[msgType];
                for (const msgPacket of msgPackets) {
                  const { amount, denom, receiver } =
                    msgPacket.packet["data__@parse__@transfer"];
                  if (receiver === address) {
                    const parts = denom.split("/");
                    transactions.push(
                      createTransaction({
                        date,
                        transactionHash,
                        transactionId,
                        receivedAmount: currency(amount, {
                          precision: 6,
                        }).divide(denominator).value,
                        receivedAsset: parts[parts.length - 1],
                        type: "Deposit",
                        feeAsset: "",
                      })
                    );
                  }
                }
                break;
              }
              default: {
                break;
              }
            }
          }
          break;
        }

        case "/cosmos.bank.v1beta1.MsgSend": {
          processed = true;
          for (const msg of msgTypeGroup[type]) {
            const { from_address, to_address, amount: amounts } = msg;
            if (from_address !== address && to_address !== address) break;

            for (const { denom, amount } of amounts) {
              const tokenAmount = currency(amount, { precision: 6 }).divide(
                denominator
              ).value;
              const token = await getIbcDenomination(denom);

              const transaction = createTransaction({
                date,
                transactionHash,
                transactionId,
              });

              if (from_address === address) {
                transaction.feeAmount = getFees(tx);
                transaction.sentAmount = tokenAmount;
                transaction.sentAsset = token;
                transaction.type = "Transfer";
              } else if (to_address === address) {
                transaction.receivedAmount = tokenAmount;
                transaction.receivedAsset = token;
                transaction.type = "Deposit";
              }

              transactions.push(transaction);
            }
          }
          break;
        }
        case "/tendermint.liquidity.v1beta1.MsgSwapWithinBatch": {
          processed = true;

          for (const msg of msgTypeGroup[type]) {
            const {
              offer_coin,
              demand_coin_denom,
              offer_coin_fee,
              order_price,
            } = msg;
            const feeDenom = await getIbcDenomination(offer_coin_fee.denom);
            const feeAmount = currency(offer_coin_fee.amount, {
              precision: 8,
            }).divide(denominator);
            const offerCoinDenom = await getIbcDenomination(offer_coin.denom);
            const offerCoinAmount = currency(offer_coin.amount, {
              precision: 8,
            }).divide(denominator);
            const demandCoinDenom = await getIbcDenomination(demand_coin_denom);
            const demandCoinAmount = offerCoinAmount.multiply(order_price);
            transactions.push(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                feeAmount: feeAmount.value,
                feeAsset: feeDenom,
                sentAmount: offerCoinAmount.value,
                sentAsset: offerCoinDenom,
                receivedAmount: demandCoinAmount.value,
                receivedAsset: demandCoinDenom,
                type: "Convert",
              })
            );
          }
          break;
        }
        case "/tendermint.liquidity.v1beta1.MsgWithdrawWithinBatch": {
          processed = true;
          for (const msg of msgTypeGroup[type]) {
            transactions.push(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                type: "Other",
                description: "Withdraw from Liquidity Pool",
                receivedAmount: currency(msg.pool_coin.amount, {
                  precision: 8,
                }).divide(denominator).value,
                receivedAsset: msg.pool_coin.denom,
                feeAmount: getFees(tx),
              })
            );
          }
          break;
        }
        case "/tendermint.liquidity.v1beta1.MsgDepositWithinBatch": {
          processed = true;
          for (const msg of msgTypeGroup[type]) {
            for (const token of msg.deposit_coins) {
              transactions.push(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  feeAmount: getFees(tx),
                  description: "Deposit to Liquidity Pool",
                  type: "Other",
                  sentAmount: currency(token.amount, { precision: 8 }).divide(
                    denominator
                  ).value,
                  sentAsset: await getIbcDenomination(token.denom),
                })
              );
            }
          }
          break;
        }
        default: {
          break;
        }
      }
    }
  }

  if (!processed) {
    // if any transactions weren't processed, will end up here
    // most of unprocessed tx will be MsgAcknowledgements
    // console.log(Object.keys(msgTypeGroup));
  }

  return transactions.map((tx) => Object.values(tx).join(",") + ",\n").join("");
}

module.exports = processTransaction;
