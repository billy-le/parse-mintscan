const fs = require("fs");
const util = require("util");
const { exec } = require("child_process");
const { format: dateFormat, parseISO, add } = require("date-fns");
const { default: bigDecimal } = require("js-big-decimal");
const transformTransaction = require("./transactions-transformers/koinly");

const execPromise = util.promisify(exec);
const precision = 18;
const denominator = Math.pow(10, precision);

function getAssetInfo(asset) {
  return asset.split(/^(\d+)(.+)/).filter((x) => x);
}

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
    const file = await fs.promises.readFile(filePath);
    const ibcDenominations = JSON.parse(file.toString());
    ibcDenominations[pathHash] = { symbol: pathHash, decimals: 6 };
    await fs.promises.writeFile(
      filePath,
      JSON.stringify(ibcDenominations, null, 2)
    );

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
  return bigDecimal.divide(
    fee.amount,
    getDenominator(feeToken.decimals),
    feeToken.decimals
  );
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
                        amount: 0,
                        decimals: token.decimals,
                      };
                    }

                    tokens[token.symbol].amount = bigDecimal.add(
                      tokens[token.symbol].amount,
                      amount
                    );
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
                  receivedAmount: bigDecimal.divide(
                    tokens[token].amount,
                    getDenominator(tokens[token].decimals),
                    tokens[token].decimals
                  ),
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
                        amount: 0,
                        decimals: token.decimals,
                      };
                    }

                    tokens[token.symbol].amount = bigDecimal.add(
                      tokens[token.symbol].amount,
                      amount
                    );
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
                  receivedAmount: bigDecimal.divide(
                    tokens[token].amount,
                    getDenominator(tokens[token].decimals),
                    tokens[token].decimals
                  ),
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
            const delegatedAmount = bigDecimal.divide(
              amount,
              getDenominator(token.decimals),
              token.decimals
            );
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  type: "Expense",
                  description: `Delegated ${delegatedAmount} ${token.symbol}`,
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
                        amount: 0,
                        decimals: token.decimals,
                      };
                    }

                    tokens[token.symbol].amount = bigDecimal.add(
                      tokens[token.symbol].amount,
                      amount
                    );
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
                  receivedAmount: bigDecimal.divide(
                    tokens[token].amount,
                    getDenominator(tokens[token].decimals),
                    tokens[token].decimals
                  ),
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
            const redelagation = bigDecimal.divide(
              amount,
              getDenominator(token.decimals),
              token.decimals
            );
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  description: `Redelegate ${redelagation} ${token.symbol}`,
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
              const transferAmount = bigDecimal.divide(
                amount,
                getDenominator(token.decimals),
                token.decimals
              );
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
                  const { receiver } =
                    msgPacket.packet["data__@parse__@transfer"];

                  if (receiver === address) {
                    for (const log of logs) {
                      for (const event of log.events) {
                        if (event.type === "transfer") {
                          let groups = [];

                          for (let i = 0; i < event.attributes.length; i += 3) {
                            const group = event.attributes.slice(i, i + 3);
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
                              const [assetAmount, assetDenom] = asset
                                .split(/^(\d+)(.+)/)
                                .filter((x) => x);
                              const token = await getIbcDenomination(
                                assetDenom
                              );

                              transactions.push(
                                ...transformTransaction(
                                  createTransaction({
                                    date,
                                    transactionHash,
                                    transactionId,
                                    receivedAmount: bigDecimal.divide(
                                      assetAmount,
                                      getDenominator(token.decimals),
                                      token.decimals
                                    ),
                                    receivedAsset: token.symbol,
                                    type: "Deposit",
                                    feeAsset: "",
                                  })
                                )
                              );
                            }
                          }
                        }
                      }
                    }
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
              const tokenAmount = bigDecimal.divide(
                amount,
                getDenominator(token.decimals),
                token.decimals
              );
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
            const feeAmount = bigDecimal.divide(
              offer_coin_fee.amount,
              getDenominator(feeDenom.decimals),
              feeDenom.decimals
            );
            const offerCoinDenom = await getIbcDenomination(offer_coin.denom);
            const offerCoinAmount = bigDecimal.divide(
              offer_coin.amount,
              getDenominator(offerCoinDenom.decimals),
              offerCoinDenom.decimals
            );
            const demandCoinDenom = await getIbcDenomination(demand_coin_denom);
            const demandCoinAmount = bigDecimal.multiply(
              offerCoinAmount,
              order_price
            );
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  feeAmount: feeAmount,
                  feeAsset: feeDenom.symbol,
                  sentAmount: offerCoinAmount,
                  sentAsset: offerCoinDenom.symbol,
                  receivedAmount: demandCoinAmount,
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
                  receivedAmount: bigDecimal.divide(
                    msg.pool_coin.amount,
                    denominator,
                    precision
                  ),
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
                    sentAmount: bigDecimal.divide(
                      amount,
                      getDenominator(token.decimals),
                      token.decimals
                    ),
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
        case "/cosmos.authz.v1beta1.MsgExec": {
          processed = true;
          const rewards = [];
          for (const log of logs) {
            for (const evt of log.events) {
              if (evt.type === "transfer") {
                const keys = new Set();
                evt.attributes.forEach(({ key }) => {
                  keys.add(key);
                });
                const length = evt.attributes.length;
                for (let i = 0; i < length; i += keys.size) {
                  const reward = evt.attributes
                    .slice(i, i + keys.size)
                    .reduce((acc, obj) => {
                      acc[obj.key] = obj.value;
                      return acc;
                    }, {});
                  if (reward.recipient === address) {
                    rewards.push(reward);
                  }
                }
              }
            }
          }

          let tokens = {};

          for (const { amount: asset } of rewards) {
            const parts = asset.split(",");
            for (const part of parts) {
              const [amount, denom] = getAssetInfo(part);
              const { symbol, decimals } = await getIbcDenomination(denom);
              if (!tokens[symbol]) {
                tokens[symbol] = {
                  amount: 0,
                  decimals: decimals,
                };
              }

              tokens[symbol].amount = bigDecimal.add(
                tokens[symbol].amount,
                amount
              );
            }
          }

          for (const token in tokens) {
            transactions.push(
              ...transformTransaction(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  receivedAmount: bigDecimal.divide(
                    tokens[token].amount,
                    getDenominator(tokens[token].decimals),
                    tokens[token].decimals
                  ),
                  receivedAsset: token,
                  feeAmount: "",
                  feeAsset: "",
                  description: "Claimed Rewards via Grant Auth",
                  type: "Staking",
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
        case "/cosmos.authz.v1beta1.MsgGrant": {
          processed = true;

          for (const log of logs) {
            for (const event of log.events) {
              if (event.type === "cosmos.authz.v1beta1.EventGrant") {
                for (const attr of event.attributes) {
                  if (attr.key === "granter" && attr.value.includes(address)) {
                    transactions.push(
                      ...transformTransaction(
                        createTransaction({
                          date,
                          transactionHash,
                          transactionId,
                          type: "Expense",
                          description: "Grant Auth",
                          feeAmount: await getFees(tx),
                        })
                      )
                    );
                  }
                }
              }
            }
          }

          break;
        }
        case "/cosmos.authz.v1beta1.MsgRevoke": {
          processed = true;
          for (const log of logs) {
            for (const event of log.events) {
              if (event.type === "cosmos.authz.v1beta1.EventRevoke") {
                for (const attr of event.attributes) {
                  if (attr.key === "granter" && attr.value.includes(address)) {
                    transactions.push(
                      ...transformTransaction(
                        createTransaction({
                          date,
                          transactionHash,
                          transactionId,
                          type: "Expense",
                          description: "Revoke Auth",
                          feeAmount: await getFees(tx),
                        })
                      )
                    );
                  }
                }
              }
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
    console.log(Object.keys(msgTypeGroup));
  }

  return transactions.map((tx) => Object.values(tx).join(",") + "\n").join("");
}

module.exports = processTransaction;
