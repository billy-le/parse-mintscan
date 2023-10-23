import fs from "fs";
import util from "util";
import { exec } from "child_process";
import { add, format as dateFormat, parseISO } from "date-fns";

import bigDecimal from "js-big-decimal";

type TxType = Record<
  string,
  {
    body: {
      messages: any[];
    };
    auth_info: {
      fee: {
        amount: Array<{ denom: string; amount: string }>;
        gas_limit: string;
        payer: string;
        granter: string;
      };
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

function getModuleType(mod: Record<"@type", string> | TxType): TxType[string] {
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
  type = "Other",
  sentAsset = "",
  sentAmount = "",
  receivedAsset = "",
  receivedAmount = "",
  feeAsset = "",
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

function getValueOfKey(
  arr: Array<{ key: string; value: string }>,
  key: string
) {
  return arr.find((item) => item.key === key);
}

function getDenominationsValueList(value: string) {
  let denoms: Array<[string, string]> = [];
  const parts = value.split(",");

  for (const part of parts) {
    let denom: string | undefined = "";
    if (part.includes("ibc/")) {
      denom = getAssetInfo(part)?.[1];
    } else {
      denom = part.match(/[a-z]+/gi)?.[0];
    }
    const amount = part.match(/\d+/gi);

    denoms.push([amount?.[0] ?? "0", denom ?? "Unknown"]);
  }

  return denoms;
}

async function processTransaction(
  address: string,
  {
    txhash: transactionHash,
    id: transactionId,
    timestamp,
    tx,
    logs,
  }: {
    txhash: string;
    id: string;
    timestamp: string;
    tx: Record<"@type", string> | TxType;
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
          | "proposal_vote"
          | "swap_within_batch"
          | "ibc_transfer"
          | "redelegate"
          | "withdraw_within_batch"
          | "timeout_packet"
          | "send_packet"
          | "cosmos.authz.v1beta1.EventGrant"
          | "cosmos.authz.v1beta1.EventRevoke";
        attributes: Array<{ key: string; value: string }>;
      }>;
    }[];
  }
) {
  let transactions: Transaction[] = [];

  const date = dateFormat(parseISO(timestamp), "yyyy-MM-dd H:mm:ss");
  const actionSet = new Set<string>();

  logs.forEach((log) => {
    log.events.forEach(({ type, attributes }) => {
      if (type === "message") {
        const action = attributes.find(({ key }) => key === "action")?.value;
        if (action) {
          actionSet.add(action);
        }
      }
    });
  });

  const actions = Array.from(actionSet);

  if (!actions.length) {
    transactions.push(
      createTransaction({
        date,
        transactionHash,
        transactionId,
        type: "Expense",
        feeAmount: await getFees(tx),
        feeAsset: "ATOM",
      })
    );
  } else {
    for (const action of actions) {
      switch (action) {
        default: {
          // console.log(action);
          break;
        }
        case "/ibc.core.client.v1.MsgUpdateClient":
        case "/ibc.core.channel.v1.MsgAcknowledgement": {
          break;
        }
        case "/ibc.core.channel.v1.MsgTimeout": {
          const filename = "timeout_txs.txt";
          for (const { events } of logs) {
            const timeoutPacket = events.find(
              ({ type }) => type === "timeout_packet"
            );
            if (timeoutPacket) {
              const [{ value: timeoutHeight }] = timeoutPacket.attributes;
              const timeout = `timeout_height: ${timeoutHeight}`;
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
          }

          break;
        }
        case "/ibc.core.channel.v1.MsgRecvPacket": {
          for (const { events } of logs) {
            for (const { type, attributes } of events) {
              if (type === "transfer") {
                const keys = new Set<string>();
                attributes.forEach(({ key }) => keys.add(key));
                for (let i = 0; i < attributes.length; i += keys.size) {
                  const [
                    { value: recipient },
                    { value: sender },
                    { value: amount },
                  ] = attributes.slice(i, (i += keys.size));

                  if (recipient === address) {
                    const denoms = getDenominationsValueList(amount);
                    for (const [amount, denom] of denoms) {
                      const { symbol, decimals } = await getIbcDenomination(
                        denom
                      );
                      const tokenAmount = bigDecimal.divide(
                        amount,
                        getDenominator(decimals),
                        decimals
                      );
                      transactions.push(
                        createTransaction({
                          date,
                          transactionHash,
                          transactionId,
                          receivedAmount: tokenAmount,
                          receivedAsset: symbol,
                          description: `Received from ${sender}`,
                          type: "Deposit",
                        })
                      );
                    }
                  }
                }
              }
            }
          }
          break;
        }
        case "/cosmos.staking.v1beta1.MsgBeginRedelegate": {
          for (const log of logs) {
            for (const { type, attributes } of log.events) {
              if (type === "redelegate") {
                const [{ value: source }, { value: dest }, { value: amount }] =
                  attributes;
                const denoms = getDenominationsValueList(amount);
                for (const [amount, denom] of denoms) {
                  const { symbol, decimals } = await getIbcDenomination(denom);
                  const tokenAmount = bigDecimal.divide(
                    amount,
                    getDenominator(decimals),
                    decimals
                  );
                  transactions.push(
                    createTransaction({
                      date,
                      transactionHash,
                      transactionId,
                      description: `Redelegated ${tokenAmount} ${symbol} from ${source} to ${dest}`,
                      feeAmount: await getFees(tx),
                      feeAsset: "ATOM",
                      type: "Expense",
                    })
                  );
                }
              }
              if (type === "transfer") {
                const keys = new Set<string>();
                attributes.forEach(({ key }) => keys.add(key));
                for (let i = 0; i < attributes.length; i += keys.size) {
                  const [{ value: recipient }, , { value: amount }] =
                    attributes.slice(i, (i += keys.size));

                  if (recipient === address) {
                    const denoms = getDenominationsValueList(amount);
                    for (const [amount, denom] of denoms) {
                      const { symbol, decimals } = await getIbcDenomination(
                        denom
                      );
                      transactions.push(
                        createTransaction({
                          date,
                          transactionHash,
                          transactionId,
                          description: `Claimed Rewards from Redelegating`,
                          receivedAmount: bigDecimal.divide(
                            amount,
                            getDenominator(decimals),
                            decimals
                          ),
                          receivedAsset: symbol,
                        })
                      );
                    }
                  }
                }
              }
            }
          }
          break;
        }
        case "/tendermint.liquidity.v1beta1.MsgWithdrawWithinBatch": {
          for (const log of logs) {
            for (const { type, attributes } of log.events) {
              if (type === "withdraw_within_batch") {
                const [, , , { value: denom }, { value: amount }] = attributes;
                transactions.push(
                  createTransaction({
                    date,
                    transactionHash,
                    transactionId,
                    description: "Remove from Liquidity Pool",
                    sentAmount: bigDecimal.divide(amount, getDenominator(6), 6),
                    sentAsset: denom,
                  })
                );
              }
            }
          }
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: "Fee for Removing from Liquidity Pool",
              feeAmount: await getFees(tx),
              feeAsset: "ATOM",
            })
          );
          break;
        }
        case "/tendermint.liquidity.v1beta1.MsgSwapWithinBatch": {
          for (const log of logs) {
            const swaps = log.events.filter(
              ({ type }) => type === "swap_within_batch"
            );
            for (const {
              attributes: [
                ,
                ,
                ,
                ,
                { value: offerDenom },
                { value: offerAmount },
                { value: offerFee },
                { value: demandDenom },
                { value: orderPrice },
              ],
            } of swaps) {
              const { symbol: offerSymbol, decimals: offerDecimals } =
                await getIbcDenomination(offerDenom);
              const offer = bigDecimal.divide(
                offerAmount,
                getDenominator(offerDecimals),
                offerDecimals
              );
              const { symbol: demandSymbol, decimals: demandDecimals } =
                await getIbcDenomination(demandDenom);
              const demand = bigDecimal.divide(
                bigDecimal.multiply(offer, orderPrice),
                1,
                demandDecimals
              );
              transactions.push(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  type: "Swap",
                  sentAmount: offer,
                  sentAsset: offerSymbol,
                  receivedAmount: demand,
                  receivedAsset: demandSymbol,
                  description: `!! Swap ${offer} ${offerSymbol} for ${demand} ${demandSymbol}`,
                  feeAmount: bigDecimal.divide(
                    offerFee,
                    getDenominator(offerDecimals),
                    offerDecimals
                  ),
                  feeAsset: offerSymbol,
                })
              );
            }
          }

          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              description: "Fee for Swapping",
              feeAmount: await getFees(tx),
              feeAsset: "ATOM",
              type: "Expense",
            })
          );

          break;
        }
        case "/cosmos.bank.v1beta1.MsgSend": {
          for (const log of logs) {
            const transfers = log.events.filter(
              ({ type }) => type === "transfer"
            );
            if (transfers.length) {
              for (const { attributes } of transfers) {
                const recipient = getValueOfKey(attributes, "recipient");
                const sender = getValueOfKey(attributes, "sender");
                const amount = getValueOfKey(attributes, "amount");
                const denoms = amount
                  ? getDenominationsValueList(amount.value)
                  : [["0", "Unknown"]];

                if (recipient?.value === address) {
                  for (const [amount, denom] of denoms) {
                    const { symbol, decimals } = await getIbcDenomination(
                      denom
                    );
                    const tokenAmount = bigDecimal.divide(
                      amount,
                      getDenominator(decimals),
                      decimals
                    );
                    transactions.push(
                      createTransaction({
                        date,
                        transactionHash,
                        transactionId,
                        type: "Deposit",
                        description: `Received from ${sender?.value}`,
                        receivedAmount: tokenAmount,
                        receivedAsset: symbol,
                      })
                    );
                  }
                } else if (sender?.value === address) {
                  for (const [amount, denom] of denoms) {
                    const { symbol, decimals } = await getIbcDenomination(
                      denom
                    );
                    const tokenAmount = bigDecimal.divide(
                      amount,
                      getDenominator(decimals),
                      decimals
                    );
                    transactions.push(
                      createTransaction({
                        date,
                        transactionHash,
                        transactionId,
                        type: "Transfer",
                        description: `Sent to ${recipient?.value}`,
                        sentAmount: tokenAmount,
                        sentAsset: symbol,
                      })
                    );
                  }

                  transactions.push(
                    createTransaction({
                      date,
                      transactionHash,
                      transactionId,
                      type: "Expense",
                      feeAmount: await getFees(tx),
                      feeAsset: "ATOM",
                      description: "Fee for Transfer",
                    })
                  );
                }
              }
            }
          }
          break;
        }
        case "/ibc.applications.transfer.v1.MsgTransfer": {
          for (const { events } of logs) {
            const transfers = events.filter(({ type }) => type === "transfer");
            const [, , { value: timeoutHeight }] =
              events.find(({ type }) => type === "send_packet")?.attributes ??
              [];

            for (const { attributes } of transfers) {
              const recipient = getValueOfKey(attributes, "recipient");
              const sender = getValueOfKey(attributes, "sender");
              const amount = getValueOfKey(attributes, "amount");
              const denoms = amount
                ? getDenominationsValueList(amount.value)
                : [["0", "Unknown"]];

              if (recipient?.value === address) {
                for (const [amount, denom] of denoms) {
                  const { symbol, decimals } = await getIbcDenomination(denom);
                  const tokenAmount = bigDecimal.divide(
                    amount,
                    getDenominator(decimals),
                    decimals
                  );
                  transactions.push(
                    createTransaction({
                      date,
                      transactionHash,
                      transactionId,
                      type: "Deposit",
                      description: `Received from ${sender?.value}`,
                      receivedAmount: tokenAmount,
                      receivedAsset: symbol,
                      meta: `timeout_height: ${timeoutHeight}`,
                    })
                  );
                }
              } else if (sender?.value === address) {
                const ibcRecipient = events
                  .find(({ type }) => type === "ibc_transfer")
                  ?.attributes?.find(({ key }) => key === "receiver");
                for (const [amount, denom] of denoms) {
                  const { symbol, decimals } = await getIbcDenomination(denom);
                  const tokenAmount = bigDecimal.divide(
                    amount,
                    getDenominator(decimals),
                    decimals
                  );
                  transactions.push(
                    createTransaction({
                      date,
                      transactionHash,
                      transactionId,
                      type: "Transfer",
                      description: `Sent to ${ibcRecipient?.value}`,
                      sentAmount: tokenAmount,
                      sentAsset: symbol,
                      meta: `timeout_height: ${timeoutHeight}`,
                    })
                  );
                }

                transactions.push(
                  createTransaction({
                    date,
                    transactionHash,
                    transactionId,
                    type: "Expense",
                    description: "Fee for IBC Transfer",
                    feeAmount: await getFees(tx),
                    feeAsset: "ATOM",
                  })
                );
              }
            }
          }

          break;
        }
        case "/cosmos.gov.v1beta1.MsgVote": {
          for (const log of logs) {
            const voteAttributes =
              log.events.find(({ type }) => type === "proposal_vote")
                ?.attributes ?? [];
            const proposalId = getValueOfKey(
              voteAttributes,
              "proposal_id"
            )?.value;

            transactions.push(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                type: "Expense",
                feeAmount: await getFees(tx),
                feeAsset: "ATOM",
                description: `Vote on #${proposalId}`,
              })
            );
          }
          break;
        }
        case "/cosmos.staking.v1beta1.MsgDelegate": {
          for (const log of logs) {
            const delegates = log.events.filter(
              ({ type }) => type === "delegate"
            );
            for (const { attributes } of delegates) {
              const amount = attributes.find(({ key }) => key === "amount");
              const denoms = amount
                ? getDenominationsValueList(amount.value)
                : [["0", "Unknown"]];
              for (const [amount, denom] of denoms) {
                const { symbol, decimals } = await getIbcDenomination(denom);
                const tokenAmount = bigDecimal.divide(
                  amount,
                  getDenominator(decimals),
                  decimals
                );

                transactions.push(
                  createTransaction({
                    date,
                    transactionHash,
                    transactionId,
                    type: "Expense",
                    description: `Delegated ${tokenAmount} ${symbol}`,
                    feeAmount: await getFees(tx),
                    feeAsset: "ATOM",
                  })
                );
              }
            }

            const transfers = log.events.filter(
              ({ type }) => type == "transfer"
            );

            for (const { attributes } of transfers) {
              const recipient = getValueOfKey(attributes, "recipient");
              if (recipient?.value === address) {
                const amount = getValueOfKey(attributes, "amount");
                const denoms = amount
                  ? getDenominationsValueList(amount.value)
                  : [["0", "Unknown"]];
                for (const [amount, denom] of denoms) {
                  const { symbol, decimals } = await getIbcDenomination(denom);
                  const tokenAmount = bigDecimal.divide(
                    amount,
                    getDenominator(decimals),
                    decimals
                  );
                  transactions.push(
                    createTransaction({
                      date,
                      transactionHash,
                      transactionId,
                      type: "Income",
                      description: "Claim Rewards from Delegating",
                      receivedAmount: tokenAmount,
                      receivedAsset: symbol,
                    })
                  );
                }
              }
            }
          }

          break;
        }
        case "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward": {
          const rewards: Record<string, string> = {};
          for (const log of logs) {
            const transfers = log.events.filter(
              (event) => event.type === "transfer"
            );
            for (const { attributes } of transfers) {
              const recipient = getValueOfKey(attributes, "recipient");
              if (recipient?.value === address) {
                const amount = getValueOfKey(attributes, "amount");

                const denoms = amount
                  ? getDenominationsValueList(amount?.value)
                  : [["0", "Unknown"]];

                for (const [amount, denom] of denoms) {
                  const tokenInfo = await getIbcDenomination(denom);
                  const tokenAmount = bigDecimal.divide(
                    amount,
                    getDenominator(tokenInfo.decimals),
                    tokenInfo.decimals
                  );

                  if (!rewards[tokenInfo.symbol]) {
                    rewards[tokenInfo.symbol] = "";
                  }

                  rewards[tokenInfo.symbol] = bigDecimal.add(
                    rewards[tokenInfo.symbol],
                    tokenAmount
                  );
                }
              }
            }
          }

          for (const token in rewards) {
            transactions.push(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                type: "Income",
                description: "Claimed Rewards",
                receivedAmount: rewards[token],
                receivedAsset: token,
              })
            );
          }

          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              feeAmount: await getFees(tx),
              feeAsset: "ATOM",
              description: "Fees from Claiming Rewards",
            })
          );

          break;
        }

        /* LEGACY ACTION TYPES */
        case "withdraw_delegator_reward": {
          const rewards: Record<string, string> = {};
          for (const log of logs) {
            const transferInfo =
              log.events.find(({ type }) => type === "transfer")?.attributes ??
              [];
            const recipient = getValueOfKey(transferInfo, "recipient");
            const amount = getValueOfKey(transferInfo, "amount");
            const denoms = amount
              ? getDenominationsValueList(amount?.value)
              : [["0", "Unknown"]];

            if (recipient?.value === address) {
              for (const [amount, denom] of denoms) {
                const tokenInfo = await getIbcDenomination(denom);
                const tokenAmount = bigDecimal.divide(
                  amount,
                  getDenominator(tokenInfo.decimals),
                  tokenInfo.decimals
                );

                if (!rewards[tokenInfo.symbol]) {
                  rewards[tokenInfo.symbol] = "";
                }

                rewards[tokenInfo.symbol] = bigDecimal.add(
                  rewards[tokenInfo.symbol],
                  tokenAmount
                );
              }
            }
          }

          for (const token in rewards) {
            transactions.push(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                type: "Income",
                description: "Claimed Rewards",
                receivedAmount: rewards[token],
                receivedAsset: token,
              })
            );
          }

          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              feeAmount: await getFees(tx),
              feeAsset: "ATOM",
              description: "Fees from Claiming Rewards",
            })
          );

          break;
        }
        case "send": {
          for (const log of logs) {
            const transferInfo =
              log.events.find(({ type }) => type === "transfer")?.attributes ??
              [];
            const recipient = getValueOfKey(transferInfo, "recipient");
            const sender = getValueOfKey(transferInfo, "sender");
            const amount = getValueOfKey(transferInfo, "amount");
            const denoms = amount
              ? getDenominationsValueList(amount?.value)
              : [["0", "Unknown"]];

            if (recipient?.value === address) {
              for (const [amount, denom] of denoms) {
                const tokenInfo = await getIbcDenomination(denom);
                const tokenAmount = bigDecimal.divide(
                  amount,
                  getDenominator(tokenInfo.decimals),
                  tokenInfo.decimals
                );

                transactions.push(
                  createTransaction({
                    date,
                    transactionHash,
                    transactionId,
                    type: "Deposit",
                    receivedAmount: tokenAmount,
                    receivedAsset: tokenInfo.symbol,
                    description: `Received from ${sender?.value}`,
                  })
                );
              }
            } else if (sender?.value === address) {
              for (const [amount, denom] of denoms) {
                const tokenInfo = await getIbcDenomination(denom);
                const tokenAmount = bigDecimal.divide(
                  amount,
                  getDenominator(tokenInfo.decimals),
                  tokenInfo.decimals
                );

                transactions.push(
                  createTransaction({
                    date,
                    transactionHash,
                    transactionId,
                    type: "Transfer",
                    receivedAmount: tokenAmount,
                    receivedAsset: tokenInfo.symbol,
                    description: `Sent to ${recipient?.value}`,
                  })
                );
              }

              transactions.push(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  type: "Expense",
                  feeAmount: await getFees(tx),
                })
              );
            }
          }

          break;
        }
        case "delegate": {
          for (const log of logs) {
            const delegateAmount = log.events
              .find(({ type }) => type === "delegate")
              ?.attributes?.find(({ key }) => key === "amount");
            const [[amount, denom]] = delegateAmount
              ? getDenominationsValueList(delegateAmount.value)
              : ["0", "Unknown"];

            const tokenAmount = bigDecimal.divide(amount, getDenominator(6), 6);

            transactions.push(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                type: "Expense",
                description: `Delegated ${tokenAmount} ATOM`,
                feeAmount: await getFees(tx),
              })
            );

            const transferInfo =
              log.events.find(({ type }) => type === "transfer")?.attributes ??
              [];
            if (transferInfo.length) {
              const receiver = getValueOfKey(transferInfo, "recipient");
              const amountInfo = getValueOfKey(transferInfo, "amount");
              const denoms = amountInfo
                ? getDenominationsValueList(amountInfo.value)
                : [["0", "Unknown"]];

              for (const [amount, denom] of denoms) {
                const tokenInfo = await getIbcDenomination(denom);
                const tokenAmount = bigDecimal.divide(
                  amount,
                  getDenominator(tokenInfo.decimals),
                  tokenInfo.decimals
                );

                if (receiver?.value === address) {
                  transactions.push(
                    createTransaction({
                      date,
                      transactionHash,
                      transactionId,
                      type: "Income",
                      description: `Claimed ${tokenAmount} ${tokenInfo.symbol}`,
                      receivedAmount: tokenAmount,
                      receivedAsset: tokenInfo.symbol,
                    })
                  );
                }
              }
            }
          }
          break;
        }
        case "vote": {
          for (const log of logs) {
            const voteAttributes =
              log.events.find(({ type }) => type === "proposal_vote")
                ?.attributes ?? [];
            const proposalId = getValueOfKey(
              voteAttributes,
              "proposal_id"
            )?.value;

            transactions.push(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                type: "Expense",
                feeAmount: await getFees(tx),
                description: `Vote on #${proposalId}`,
              })
            );
          }

          break;
        }

        case "swap_within_batch": {
          for (const log of logs) {
            const swapWithinBranch = log.events.filter(
              ({ type }) => type === "swap_within_batch"
            );

            for (const {
              attributes: [
                ,
                ,
                ,
                ,
                { value: offerCoinDenom },
                { value: offerCoinAmount },
                { value: offerCoinFee },
                { value: demandCoinDenom },
                { value: orderPrice },
              ],
            } of swapWithinBranch) {
              const { symbol: offerSymbol, decimals: offerDecimals } =
                await getIbcDenomination(offerCoinDenom);
              const offerCoinValue = bigDecimal.divide(
                offerCoinAmount,
                getDenominator(offerDecimals),
                offerDecimals
              );
              const offerFee = bigDecimal.divide(
                offerCoinFee,
                getDenominator(offerDecimals),
                offerDecimals
              );
              const { symbol: demandSymbol, decimals: demandDecimals } =
                await getIbcDenomination(demandCoinDenom);
              const amount = bigDecimal.divide(
                bigDecimal.multiply(offerCoinValue, orderPrice),
                1,
                demandDecimals
              );
              transactions.push(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  type: "Swap",
                  description: `Swapped ${offerCoinValue} ${offerSymbol} for ${amount} ${demandSymbol}`,
                  sentAmount: offerCoinValue,
                  sentAsset: offerSymbol,
                  receivedAmount: amount,
                  receivedAsset: demandSymbol,
                  feeAsset: offerSymbol,
                  feeAmount: offerFee,
                })
              );
            }
          }

          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              feeAmount: await getFees(tx),
              feeAsset: "ATOM",
              description: "Fee for Swapping",
            })
          );
          break;
        }
        case "deposit_within_batch": {
          for (const log of logs) {
            const transfers = log.events.filter(
              ({ type }) => type === "transfer"
            );

            if (transfers.length) {
              for (const { attributes } of transfers) {
                const recipient = getValueOfKey(attributes, "recipient");
                const sender = getValueOfKey(attributes, "sender");
                const amount = getValueOfKey(attributes, "amount");
                const denoms = amount
                  ? getDenominationsValueList(amount.value)
                  : [["0", "Unknown"]];

                if (recipient?.value === address) {
                  for (const [amount, denom] of denoms) {
                    const { symbol, decimals } = await getIbcDenomination(
                      denom
                    );
                    const tokenAmount = bigDecimal.divide(
                      amount,
                      getDenominator(decimals),
                      decimals
                    );
                    transactions.push(
                      createTransaction({
                        date,
                        transactionHash,
                        transactionId,
                        type: "Income",
                        description: "Received from Liquidity Pool",
                        receivedAmount: tokenAmount,
                        receivedAsset: symbol,
                      })
                    );
                  }
                } else if (sender?.value === address) {
                  for (const [amount, denom] of denoms) {
                    const { symbol, decimals } = await getIbcDenomination(
                      denom
                    );
                    const tokenAmount = bigDecimal.divide(
                      amount,
                      getDenominator(decimals),
                      decimals
                    );
                    transactions.push(
                      createTransaction({
                        date,
                        transactionHash,
                        transactionId,
                        type: "Swap",
                        description: "Add to Liquidity Pool",
                        sentAmount: tokenAmount,
                        sentAsset: symbol,
                      })
                    );
                  }

                  transactions.push(
                    createTransaction({
                      date,
                      transactionHash,
                      transactionId,
                      type: "Expense",
                      description: "Fee for adding to Liquidity Pool",
                      feeAmount: await getFees(tx),
                      feeAsset: "ATOM",
                    })
                  );
                }
              }
            }
          }
          break;
        }
        case "begin_redelegate": {
          for (const log of logs) {
            const redelegations = log.events.filter(
              ({ type }) => type === "redelegate"
            );

            for (const { attributes } of redelegations) {
              const source = getValueOfKey(attributes, "source_validator");
              const dest = getValueOfKey(attributes, "destination_validator");
              const amount = getValueOfKey(attributes, "amount");
              transactions.push(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  type: "Expense",
                  description: `Redelgated ${bigDecimal.divide(
                    amount?.value,
                    getDenominator(6),
                    6
                  )} ATOM from ${source?.value} to ${dest?.value}`,
                  feeAmount: await getFees(tx),
                  feeAsset: "ATOM",
                })
              );
            }

            const transfers = log.events.filter(
              ({ type }) => type === "transfer"
            );

            for (const { attributes } of transfers) {
              const amount = attributes
                .filter(({ key }) => key === "amount")
                .reduce((sum, amount) => {
                  const [[value, denom]] = getDenominationsValueList(
                    amount.value
                  );

                  return bigDecimal.add(
                    sum,
                    bigDecimal.divide(value, getDenominator(6), 6)
                  );
                }, "0");

              transactions.push(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  type: "Income",
                  receivedAmount: amount,
                  receivedAsset: "ATOM",
                  description: "Claimed Rewards from Redelegating",
                })
              );
            }
          }
          break;
        }
      }
    }
  }

  return transactions.map((tx) => Object.values(tx).join(",") + "\n").join("");
}

export default processTransaction;
