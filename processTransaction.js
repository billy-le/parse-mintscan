const fs = require("fs");
const util = require("util");
const currency = require("currency.js");
const { exec } = require("child_process");
const { format: dateFormat, parseISO } = require("date-fns");
const transformTransaction = require("./transactions-transformers/koinly");

const execPromise = util.promisify(exec);
const precision = 18;
const denominator = Math.pow(10, precision);

function getDenominator(decimals) {
  return Math.pow(10, decimals);
}

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

    ibcDenominations[pathHash] = { symbol: token, decimals: 6 };

    await fs.promises.writeFile(
      filePath,
      JSON.stringify(ibcDenominations, null, 2)
    );
    return token;
  } catch (err) {
    console.log(err);
    return { symbol: "Unknown", decimals: 0 };
  }
}

function createTransaction({
  date,
  type = "",
  sentAsset = "",
  sentAmount = "",
  receivedAsset = "",
  receivedAmount = "",
  feeAsset = "EVMOS",
  feeAmount = "",
  marketValueCurrency = "",
  marketValue = "",
  description = "",
  transactionHash = "",
  transactionId = "",
  meta = "",
}) {
  return {
    date,
    sentAmount,
    sentAsset,
    receivedAmount,
    receivedAsset,
    feeAmount,
    feeAsset,
    marketValue,
    marketValueCurrency,
    type,
    description,
    transactionHash,
    transactionId,
    meta,
  };
}

async function getFees(tx) {
  const { auth_info } = getModuleType(tx);
  const fee = auth_info.fee.amount[0];
  const feeToken = await getIbcDenomination(fee.denom);
  return currency(fee.amount, { precision: feeToken.decimals }).divide(
    Math.pow(10, feeToken.decimals)
  ).value;
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
      ...transformTransaction(
        createTransaction({
          date,
          transactionHash,
          transactionId,
          feeAmount: await getFees(tx),
          type: "Expense",
          description: "Transaction Failed",
        })
      )
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
            ...transformTransaction(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                type: "Expense",
                description: `Vote on ${proposals.join(" ")}`,
                feeAmount: await getFees(tx),
              })
            )
          );
          break;
        }

        case "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward": {
          processed = true;

          let tokens = {};

          for (const log of logs) {
            for (const evt of log.events) {
              if (evt.type == "transfer") {
                const groups = [];
                for (let i = 0; i < evt.attributes.length; i += 3) {
                  const group = evt.attributes.slice(i, i + 3);
                  const recipient = group[0];
                  const sender = group[1];
                  const amount = group[2];
                  if (recipient.value === address) {
                    groups.push({
                      recipient: recipient.value,
                      sender: sender.value,
                      amount: amount.value,
                    });
                  }
                }

                for (const { amount } of groups) {
                  const assets = amount.split(",");
                  for (const asset of assets) {
                    const [amount, _token] = asset
                      .split(/^(\d+)(.+)/)
                      .filter((x) => x);
                    const token = await getIbcDenomination(_token);

                    if (!tokens[token.symbol]) {
                      tokens[token.symbol] = {
                        amount: currency(0, {
                          precision: token.decimals,
                        }),
                        decimals: token.decimals,
                      };
                    }

                    tokens[token.symbol] = {
                      amount: tokens[token.symbol].amount.add(amount),
                      decimals: token.decimals,
                    };
                  }
                }
              }
            }
          }

          for (const token in tokens) {
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  receivedAmount: tokens[token].amount.divide(
                    getDenominator(tokens[token].decimals)
                  ).value,
                  receivedAsset: token,
                  type: "Staking",
                  description: `Claimed Rewards`,
                  feeAmount: "",
                  feeAsset: "",
                })
              )
            );
          }

          transactions.push(
            ...transformTransaction(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                feeAmount: await getFees(tx),
                type: "Expense",
              })
            )
          );

          break;
        }
        case "/cosmos.staking.v1beta1.MsgDelegate": {
          if (
            Object.keys(msgTypeGroup).includes(
              "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward"
            )
          )
            break;
          processed = true;
          let tokens = {};

          for (const log of logs) {
            for (const evt of log.events) {
              if (evt.type === "transfer") {
                const groups = [];
                for (let i = 0; i < evt.attributes.length; i += 3) {
                  const group = evt.attributes.slice(i, i + 3);
                  const recipient = group[0];
                  const sender = group[1];
                  const amount = group[2];
                  if (recipient.value === address) {
                    groups.push({
                      recipient: recipient.value,
                      sender: sender.value,
                      amount: amount.value,
                    });
                  }
                }

                for (const { amount } of groups) {
                  const assets = amount.split(",");
                  for (const asset of assets) {
                    const [amount, _token] = asset
                      .split(/^(\d+)(.+)/)
                      .filter((x) => x);
                    const token = await getIbcDenomination(_token);
                    if (!tokens[token.symbol]) {
                      tokens[token.symbol] = {
                        amount: currency(0, {
                          precision: token.decimals,
                        }),
                        decimals: token.decimals,
                      };
                    }

                    tokens[token.symbol] = {
                      amount: tokens[token.symbol].amount.add(amount),
                      decimals: token.decimals,
                    };
                  }
                }
              }
            }
          }

          for (const token in tokens) {
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  receivedAmount: tokens[token].amount.divide(
                    getDenominator(tokens[token].decimals)
                  ).value,
                  receivedAsset: token,
                  type: "Staking",
                  description: `Claimed Rewards`,
                  feeAmount: "",
                  feeAsset: "",
                })
              )
            );
          }

          for (const {
            amount: { denom, amount },
          } of msgTypeGroup[type]) {
            const token = await getIbcDenomination(denom);
            const delegatedAmount = currency(amount, {
              precision: token.decimals,
            }).divide(getDenominator(token.decimals));
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  type: "Expense",
                  description: `Delegated ${delegatedAmount.value} ${token.symbol}`,
                  feeAmount: await getFees(tx),
                })
              )
            );
          }

          break;
        }
        case "/cosmos.staking.v1beta1.MsgBeginRedelegate": {
          processed = true;
          let tokens = {};

          for (const log of logs) {
            for (const evt of log.events) {
              if (evt.type === "transfer") {
                const groups = [];
                for (let i = 0; i < evt.attributes.length; i += 3) {
                  const group = evt.attributes.slice(i, i + 3);
                  const recipient = group[0];
                  const sender = group[1];
                  const amount = group[2];
                  if (recipient.value === address) {
                    groups.push({
                      recipient: recipient.value,
                      sender: sender.value,
                      amount: amount.value,
                    });
                  }
                }

                for (const { amount } of groups) {
                  const assets = amount.split(",");
                  for (const asset of assets) {
                    const [amount, _token] = asset
                      .split(/^(\d+)(.+)/)
                      .filter((x) => x);
                    const token = await getIbcDenomination(_token);
                    if (!tokens[token.symbol]) {
                      tokens[token.symbol] = {
                        amount: currency(0, {
                          precision: token.decimals,
                        }),
                        decimals: token.decimals,
                      };
                    }

                    tokens[token.symbol] = {
                      amount: tokens[token.symbol].amount.add(amount),
                      decimals: token.decimals,
                    };
                  }
                }
              }
            }
          }

          for (const token in tokens) {
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  receivedAmount: tokens[token].amount.divide(
                    getDenominator(tokens[token].decimals)
                  ).value,
                  receivedAsset: token,
                  type: "Staking",
                  description: `Claimed Rewards`,
                  feeAmount: "",
                  feeAsset: "",
                })
              )
            );
          }

          for (const {
            amount: { denom, amount },
          } of msgTypeGroup[type]) {
            const token = await getIbcDenomination(denom);
            const redelagation = currency(amount, {
              precision: token.decimals,
            }).divide(getDenominator(token.decimals));
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  description: `Redelegate ${redelagation.value} ${token.symbol}`,
                  type: "Expense",
                  feeAmount: await getFees(tx),
                })
              )
            );
          }

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

            for (const _token of tokens) {
              const transaction = createTransaction({
                date,
                transactionHash,
                transactionId,
                feeAmount: await getFees(tx),
                meta: `timeout_height: ${revision_number}_${revision_height}`,
              });
              const token = await getIbcDenomination(_token);
              const transferAmount = currency(amount, {
                precision: token.decimals,
              }).divide(getDenominator(token.decimals)).value;
              if (sender === address) {
                transaction.sentAmount = transferAmount;
                transaction.sentAsset = token.symbol;
                transaction.type = "Transfer";
              } else if (receiver === address) {
                transaction.receivedAmount = transferAmount;
                transaction.receivedAsset = token.symbol;
                transaction.type = "Deposit";
              }
              transactions.push(...transformTransaction(transaction));
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
                const filename = "timeout_txs.txt";
                processed = true;
                for (const msg of msgTypeGroup[msgType]) {
                  const {
                    packet: {
                      timeout_height: { revision_number, revision_height },
                    },
                  } = msg;
                  const timeout = `timeout_height: ${revision_number}_${revision_height}`;

                  try {
                    // when an ibc transaction timeouts, we need to remove the entry from the data.csv
                    // so we store all timeout txs in a file
                    const txs = await fs.promises.readFile(filename, "utf-8");
                    if (!txs.includes(timeout)) {
                      await fs.promises.writeFile(filename, `${timeout}\n`, {
                        flag: "a",
                      });
                    }
                  } catch (err) {
                    await fs.promises.writeFile(filename, `${timeout}\n`);
                  }
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

                    const token = await getIbcDenomination(
                      parts[parts.length - 1]
                    );

                    transactions.push(
                      ...transformTransaction(
                        createTransaction({
                          date,
                          transactionHash,
                          transactionId,
                          receivedAmount: currency(amount, {
                            precision: token.decimals,
                          }).divide(getDenominator(token.decimals)).value,
                          receivedAsset: token.symbol,
                          type: "Deposit",
                          feeAsset: "",
                        })
                      )
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

            for (const { denom, amount } of amounts) {
              const token = await getIbcDenomination(denom);
              const tokenAmount = currency(amount, {
                precision: token.decimals,
              }).divide(getDenominator(token.decimals)).value;
              const transaction = createTransaction({
                date,
                transactionHash,
                transactionId,
              });

              if (from_address === address) {
                transaction.feeAmount = await getFees(tx);
                transaction.sentAmount = tokenAmount;
                transaction.sentAsset = token.symbol;
                transaction.type = "Transfer";
                transactions.push(...transformTransaction(transaction));
              } else if (to_address === address) {
                transaction.receivedAmount = tokenAmount;
                transaction.receivedAsset = token.symbol;
                transaction.type = "Deposit";
                transactions.push(...transformTransaction(transaction));
              }
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
              precision: feeDenom.decimals,
            }).divide(getDenominator(feeDenom.decimals));
            const offerCoinDenom = await getIbcDenomination(offer_coin.denom);
            const offerCoinAmount = currency(offer_coin.amount, {
              precision: offerCoinDenom.decimals,
            }).divide(getDenominator(offerCoinDenom.decimals));
            const demandCoinDenom = await getIbcDenomination(demand_coin_denom);
            const demandCoinAmount = offerCoinAmount.multiply(order_price, {
              precision: demandCoinDenom.decimals,
            });
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  feeAmount: feeAmount.value,
                  feeAsset: feeDenom.symbol,
                  sentAmount: offerCoinAmount.value,
                  sentAsset: offerCoinDenom.symbol,
                  receivedAmount: demandCoinAmount.value,
                  receivedAsset: demandCoinDenom.symbol,
                  type: "Swap",
                })
              )
            );
          }
          break;
        }
        case "/tendermint.liquidity.v1beta1.MsgWithdrawWithinBatch": {
          processed = true;

          for (const msg of msgTypeGroup[type]) {
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  type: "Other",
                  description: "Withdraw from Liquidity Pool",
                  receivedAmount: currency(msg.pool_coin.amount, {
                    precision,
                  }).divide(denominator).value,
                  receivedAsset: msg.pool_coin.denom,
                  feeAmount: await getFees(tx),
                })
              )
            );
          }
          break;
        }
        case "/tendermint.liquidity.v1beta1.MsgDepositWithinBatch": {
          processed = true;
          for (const msg of msgTypeGroup[type]) {
            for (const { denom, amount } of msg.deposit_coins) {
              const token = await getIbcDenomination(denom);

              transactions.push(
                ...transformTransaction(
                  createTransaction({
                    date,
                    transactionHash,
                    transactionId,
                    description: "Deposit to Liquidity Pool",
                    type: "Other",
                    sentAmount: currency(amount, {
                      precision: token.decimals,
                    }).divide(getDenominator(token.decimals)).value,
                    sentAsset: token.symbol,
                  })
                )
              );
            }

            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  feeAmount: await getFees(tx),
                  description: "Deposit to Liquidity Pool",
                  type: "Expense",
                })
              )
            );
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

  return transactions.map((tx) => Object.values(tx).join(",") + "\n").join("");
}

module.exports = processTransaction;
