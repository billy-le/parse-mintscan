import fs from "fs";
import util from "util";
import { exec } from "child_process";
import { format as dateFormat, parseISO } from "date-fns";

import bigDecimal from "js-big-decimal";
import transformTransaction from "./transactions-transformers/koinly.ts";

type TxType = Record<
  string,
  {
    body: {
      messages: any[];
    };
    auth_info: {
      fee: { amount: Array<{ denom: string; amount: string }> };
    };
  }
>;

const execPromise = util.promisify(exec);
const precision = 6;
const denominator = Math.pow(10, precision);

function getAssetInfo(asset: string) {
  return asset.split(/^(\d+)(.+)/).filter((x) => x);
}

function getDenominator(decimals: number) {
  return Math.pow(10, decimals);
}

function getModuleType(mod: Record<"@type", string> | TxType): {
  body: {
    messages: any[];
  };
  auth_info: { fee: { amount: Array<{ denom: string; amount: string }> } };
} {
  const type = (mod["@type"] as string).replaceAll(".", "-");
  return (mod as TxType)[type];
}

async function getIbcDenomination(pathHash: string) {
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

    if (stdout) {
      const token = stdout
        .split("\n")
        .find((part) => part.includes("base_denom"))
        ?.replaceAll(/base_denom:/gi, "")
        ?.replaceAll(" ", "");

      ibcDenominations[pathHash] = { symbol: token, decimals: 6 };

      await fs.promises.writeFile(
        filePath,
        JSON.stringify(ibcDenominations, null, 2)
      );
      return token;
    }
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
  date = "",
  type = "",
  sentAsset = "",
  sentAmount = "",
  receivedAsset = "",
  receivedAmount = "",
  feeAsset = "JUNO",
  feeAmount = "",
  marketValueCurrency = "",
  marketValue = "",
  description = "",
  transactionHash = "",
  transactionId = "",
  meta = "",
}: Transaction) {
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

async function getFees(tx: any) {
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
  address: string,
  {
    txhash: transactionHash,
    id: transactionId,
    timestamp,
    tx,
    logs,
    memo,
  }: {
    txhash: string;
    id: string;
    timestamp: string;
    tx: Record<"@type", string> | TxType;
    memo: string;
    logs: {
      events: Array<{
        type:
          | "delegate"
          | "coin_received"
          | "transfer"
          | "coin_spent"
          | "message"
          | "claim"
          | "withdraw_rewards"
          | "wasm"
          | "cosmos.authz.v1beta1.EventGrant"
          | "cosmos.authz.v1beta1.EventRevoke";
        attributes: Array<{ key: string; value: string }>;
      }>;
    }[];
  }
) {
  const date = dateFormat(parseISO(timestamp), "yyyy-MM-dd H:mm:ss");

  let transactions = [];

  const { body } = getModuleType(tx);

  const msgTypeGroup: Record<string, Array<any>> = {};

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

          let tokens: Record<
            string,
            { amount: string | number; decimals: number }
          > = {};

          for (const log of logs) {
            for (const evt of log.events) {
              if (evt.type == "transfer") {
                const keys = new Set();
                evt.attributes.forEach(({ key }) => {
                  keys.add(key);
                });
                const groups = [];
                for (let i = 0; i < evt.attributes.length; i += keys.size) {
                  const group = evt.attributes.slice(i, i + keys.size);

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
          let tokens: Record<
            string,
            { amount: number | string; decimals: number }
          > = {};

          for (const log of logs) {
            for (const evt of log.events) {
              if (evt.type === "transfer") {
                const keys = new Set();
                evt.attributes.forEach(({ key }) => {
                  keys.add(key);
                });
                const groups = [];
                for (let i = 0; i < evt.attributes.length; i += keys.size) {
                  const group = evt.attributes.slice(i, i + keys.size);
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
              } else {
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
          let tokens: Record<
            string,
            { amount: string | number; decimals: number }
          > = {};

          for (const log of logs) {
            for (const evt of log.events) {
              if (evt.type === "transfer") {
                const keys = new Set();
                evt.attributes.forEach(({ key }) => {
                  keys.add(key);
                });
                const groups = [];
                for (let i = 0; i < evt.attributes.length; i += keys.size) {
                  const group = evt.attributes.slice(i, i + keys.size);
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
                try {
                  const json = JSON.parse(receiver);
                  if (json?.autopilot?.receiver) {
                    transaction.description = `Sent to ${json.autopilot.receiver}`;
                  }
                } catch (err) {
                  transaction.description = `Sent to ${receiver}`;
                }
                transaction.sentAmount = transferAmount;
                transaction.sentAsset = token.symbol;
                transaction.type = "Transfer";
              } else if (receiver === address) {
                try {
                } catch (err) {
                  transaction.description = `Received from ${sender}`;
                }
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
              case "/ibc.core.client.v1.MsgUpdateClient": {
                break;
              }
              case "/ibc.core.channel.v1.MsgAcknowledgement": {
                processed = true;
                // not used by end consumer
                for (const log of logs) {
                  for (const event of log.events) {
                    if (event.type === "transfer") {
                      const keys = new Set<string>();
                      event.attributes.forEach(({ key }) => keys.add(key));
                      const groups: Array<{
                        recipient: string;
                        sender: string;
                        amount: string;
                      }> = [];
                      for (
                        let i = 0;
                        i < event.attributes.length;
                        i += keys.size
                      ) {
                        const [recipient, sender, amount] =
                          event.attributes.slice(i, i + keys.size);
                        if (recipient.value === address) {
                          groups.push({
                            recipient: recipient.value,
                            sender: sender.value,
                            amount: amount.value,
                          });
                        } else if (sender.value === address) {
                        }
                      }

                      for (const { sender, recipient, amount } of groups) {
                        const [value, denom] = getAssetInfo(amount);
                        const token = await getIbcDenomination(denom);
                        transactions.push(
                          ...transformTransaction(
                            createTransaction({
                              date,
                              transactionHash,
                              transactionId,
                              type: "Deposit",
                              description: "Received from " + sender,
                              receivedAmount: bigDecimal.divide(
                                value,
                                getDenominator(token.decimals),
                                token.decimals
                              ),
                              receivedAsset: token.symbol,
                            })
                          )
                        );
                      }
                    }
                  }
                }
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

                const groups = [];

                for (const log of logs) {
                  for (const event of log.events) {
                    if (event.type === "transfer") {
                      const keys = new Set();
                      event.attributes.forEach(({ key }) => {
                        keys.add(key);
                      });

                      for (
                        let i = 0;
                        i < event.attributes.length;
                        i += keys.size
                      ) {
                        const group = event.attributes.slice(i, i + keys.size);
                        const recipient = group[0];
                        const sender = group[1];
                        const amount = group[2];
                        if (recipient.value === address) {
                          groups.push({
                            recipient: recipient.value,
                            sender: sender.value,
                            amount: amount.value,
                          });
                        } else if (sender.value === address) {
                          console.log({ sender, recipient, amount });
                        }
                      }
                    }
                  }
                }

                for (const { amount, recipient, sender } of groups) {
                  const assets = amount.split(",");
                  for (const asset of assets) {
                    const [assetAmount, assetDenom] = asset
                      .split(/^(\d+)(.+)/)
                      .filter((x) => x);
                    const token = await getIbcDenomination(assetDenom);

                    if (recipient === address) {
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
                    } else {
                      console.log(amount);
                    }
                  }
                }
                break;
              }
              default: {
                // console.log(msgType);
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
          const rewards: Array<{
            recipient: string;
            sender: string;
            amount: string;
          }> = [];
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
                      acc[obj.key as keyof (typeof rewards)[number]] =
                        obj.value;
                      return acc;
                    }, {} as (typeof rewards)[number]);
                  if (reward.recipient === address) {
                    rewards.push(reward);
                  }
                }
              } else {
              }
            }
          }

          let tokens: Record<
            string,
            { amount: string | number; decimals: number }
          > = {};

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
          // transactions.push(
          //   ...transformTransaction(
          //     createTransaction({
          //       date,
          //       transactionHash,
          //       transactionId,
          //       feeAmount: await getFees(tx),
          //       type: "Expense",
          //     })
          //   )
          // );
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
        case "/cosmwasm.wasm.v1.MsgExecuteContract": {
          for (const log of logs) {
            for (const event of log.events) {
              if (event.type === "wasm") {
                const groups = [];
                let contractIndexes = [];

                for (let i = 0; i < event.attributes.length; i++) {
                  const attr = event.attributes[i];

                  if (attr.key == "_contract_address") {
                    contractIndexes.push(i);
                  }
                }

                for (let i = 0; i < contractIndexes.length; i++) {
                  const start = contractIndexes[i];
                  const end = contractIndexes[i + 1];
                  const group = event.attributes.slice(start, end);
                  groups.push(group);
                }

                for (const group of groups) {
                  const action = group.find(({ key }) => key === "action");
                  const swap = group.find(({ key }) => key === "native_sold");
                  const liquidity = group.find(
                    ({ key }) => key === "liquidity_received"
                  );
                  const contractAddress = group.find(
                    ({ key }) => key === "_contract_address"
                  );

                  const file = await fs.promises.readFile(
                    "./smart-contracts/juno.json"
                  );
                  const smartContracts = JSON.parse(file.toString());

                  if (!smartContracts[contractAddress.value]) {
                    const data = await fetch(
                      `https://lcd-juno.validavia.me/cosmwasm/wasm/v1/contract/${contractAddress.value}`,
                      {
                        headers: {
                          accept: "application/json",
                        },
                      }
                    ).then((res) => {
                      if (res.ok) {
                        return res.json();
                      }
                      return undefined;
                    });

                    if (data) {
                      smartContracts[contractAddress.value] = data;

                      await fs.promises.writeFile(
                        "./smart-contracts/juno.json",
                        JSON.stringify(smartContracts, null, 2)
                      );
                    }
                  }

                  if (action?.value) {
                    switch (action.value) {
                      case "delegate": {
                        transactions.push(
                          ...transformTransaction(
                            createTransaction({
                              date,
                              transactionHash,
                              transactionId,
                              feeAmount: await getFees(tx),
                              description: `Delegate`,
                            })
                          )
                        );

                        break;
                      }
                      case "bond": {
                        break;
                      }
                      case "withdraw_rewards": {
                        break;
                      }
                      case "transfer": {
                        try {
                          if (
                            !smartContracts[contractAddress.value].token_info
                          ) {
                            const data = await fetch(
                              `https://lcd-juno.validavia.me/cosmwasm/wasm/v1/contract/${contractAddress.value}/smart/eyJ0b2tlbl9pbmZvIjp7fX0=?encoding=UTF-8`
                            ).then((res) => {
                              if (res.ok) return res.json();
                              return undefined;
                            });

                            if (data) {
                              smartContracts[contractAddress.value].token_info =
                                data;
                              await fs.promises.writeFile(
                                "./smart-contracts/juno.json",
                                JSON.stringify(smartContracts, null, 2)
                              );
                            }
                          }

                          const tokenInfo =
                            smartContracts[contractAddress.value].token_info;
                          const sender = group.find(
                            ({ key }) => key === "from"
                          );
                          const receiver = group.find(
                            ({ key }) => key === "to"
                          );
                          const amount = group.find(
                            ({ key }) => key === "amount"
                          );
                          const transaction = createTransaction({
                            date,
                            transactionHash,
                            transactionId,
                          });
                          if (receiver?.value === address) {
                            transaction.receivedAmount = bigDecimal.divide(
                              amount.value,
                              getDenominator(tokenInfo.decimals),
                              tokenInfo.decimals
                            );
                            transaction.receivedAsset = tokenInfo.symbol;
                            transaction.description = `Received from ${sender.value}`;
                          } else if (sender?.value === address) {
                            transaction.sentAmount = bigDecimal.divide(
                              amount.value,
                              getDenominator(tokenInfo.decimals),
                              tokenInfo.decimals
                            );
                            transaction.sentAsset = tokenInfo.symbol;
                            transaction.description = `Sent to ${receiver.value}`;
                          }
                          transactions.push(
                            ...transformTransaction(transaction)
                          );
                        } catch (err) {
                          console.log(err);
                        }

                        break;
                      }
                      case "claim": {
                        const coinGroup = groups.find((group) =>
                          group.find(({ value }) => value === "transfer")
                        );
                        const stage = groups
                          .find((group) =>
                            group.find(({ key }) => key === "stage")
                          )
                          ?.find((group) => group.key === "stage");
                        const coinAddress = coinGroup?.find(
                          ({ key }) => key === "_contract_address"
                        );
                        const amount = coinGroup?.find(
                          ({ key }) => key === "amount"
                        );
                        const tokenInfo =
                          smartContracts[coinAddress.value].token_info;
                        const value = bigDecimal.divide(
                          amount?.value,
                          getDenominator(tokenInfo.decimals),
                          tokenInfo.decimals
                        );
                        transactions.push(
                          createTransaction({
                            date,
                            transactionHash,
                            transactionId,
                            description: `Claimed ${value} ${tokenInfo.symbol}${
                              stage ? " Airdrop" : ""
                            }`,
                            feeAmount: await getFees(tx),
                          })
                        );
                        break;
                      }
                      case "vote": {
                        break;
                      }
                      case "send": {
                        break;
                      }
                      case "stake": {
                        break;
                      }
                      case "unstake": {
                        break;
                      }
                      case "increase_allowance": {
                        break;
                      }
                      case "transfer_from": {
                        break;
                      }
                      case "mint": {
                        break;
                      }
                      default: {
                        console.log(action.value);
                        break;
                      }
                    }
                  } else if (swap) {
                    const bought = group.find(
                      ({ key }) => key === "token_bought"
                    );
                    const infoBase64 = Buffer.from('{"info": {}}', "utf-8");

                    try {
                      const data = await fetch(
                        `https://lcd-juno.validavia.me/cosmwasm/wasm/v1/contract/${
                          contractAddress.value
                        }/smart/${infoBase64.toString("base64")}?encoding=UTF-8`
                      ).then((res) => {
                        if (res.ok) return res.json();
                        return undefined;
                      });

                      if (data) {
                        smartContracts[contractAddress.value].swap = data.data;
                        await fs.promises.writeFile(
                          "./smart-contracts/juno.json",
                          JSON.stringify(smartContracts, null, 2)
                        );
                      }
                    } catch (err) {
                      console.log(err);
                    }

                    const token1 =
                      smartContracts[contractAddress.value]?.swap.token1_denom;
                    const token2 =
                      smartContracts[contractAddress.value]?.swap.token2_denom;

                    transactions.push(
                      ...transformTransaction(
                        createTransaction({
                          date,
                          transactionHash,
                          transactionId,
                          type: "Swap",
                          sentAmount: bigDecimal.divide(
                            swap.value,
                            getDenominator(6),
                            6
                          ),
                          sentAsset: "HULC",
                          receivedAmount: bigDecimal.divide(
                            bought.value,
                            getDenominator(6),
                            6
                          ),
                          receivedAsset: "JUNO",
                          feeAmount: await getFees(tx),
                        })
                      )
                    );
                  } else if (liquidity) {
                    const token1 = group.find(
                      ({ key }) => key === "token1_amount"
                    ); // atom
                    const token2 = group.find(
                      ({ key }) => key === "token1_amount"
                    ); // juno
                  } else {
                    console.log(group);
                  }
                }
              } else {
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
  }

  return transactions.map((tx) => Object.values(tx).join(",") + "\n").join("");
}

export default processTransaction;
