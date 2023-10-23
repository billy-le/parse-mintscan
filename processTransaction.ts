import fs from "fs";
import util from "util";
import { exec } from "child_process";
import { format as dateFormat, parseISO } from "date-fns";

import bigDecimal from "js-big-decimal";

// processors
import { msgTimout } from "./processors/msgTimeout";
import { msgRecvPacket } from "./processors/msgRecvPacket";
import { msgBeginRedelegate } from "./processors/msgBeginRedelegate";
import { msgWithdrawWithinBatch } from "./processors/msgWithdrawWithinBatch";
import { msgSwapWithinBatch } from "./processors/msgSwapWithinBatch";
import { msgSend } from "./processors/msgSend";
import { ibcMsgTransfer } from "./processors/ibcMsgTransfer";
import { msgVote } from "./processors/msgVote";
import { msgDelegate } from "./processors/msgDelegate";
import { msgWithdrawDelegatorReward } from "./processors/msgWithdrawDelegatorReward";
import { legacyWithdrawDelegatorReward } from "./processors/legacyWithdrawDelegatorReward";
import { legacySend } from "./processors/legacySend";

const execPromise = util.promisify(exec);

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
  baseSymbol: string,
  baseDecimals: number,
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
        feeAsset: baseSymbol,
      })
    );
  } else {
    for (const action of actions) {
      switch (action) {
        default: {
          break;
        }
        case "/ibc.core.client.v1.MsgUpdateClient":
        case "/ibc.core.channel.v1.MsgAcknowledgement": {
          break;
        }
        case "/cosmwasm.wasm.v1.MsgExecuteContract": {
          for (const { events } of logs) {
            const action = events
              .find((evt) => evt.type == "wasm")
              ?.attributes?.find(({ key }) => key === "action")?.value;

            switch (action) {
              default: {
                break;
              }
            }
            // const keys = new Set();
            // events.forEach(({ type }) => keys.add(type));

            // for (const { type, attributes } of events) {
            //   if (type === "wasm") {
            //     const action = attributes.find(
            //       ({ key }) => key === "action"
            //     )?.value;
            //     console.log(action);
            //   }
            // }
          }
          break;
        }
        case "/ibc.core.channel.v1.MsgTimeout": {
          await msgTimout(baseSymbol, logs);
          break;
        }
        case "/ibc.core.channel.v1.MsgRecvPacket": {
          const txs = await msgRecvPacket(address, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "/cosmos.staking.v1beta1.MsgBeginRedelegate": {
          const txs = await msgBeginRedelegate(address, baseSymbol, tx, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "/tendermint.liquidity.v1beta1.MsgWithdrawWithinBatch": {
          const txs = msgWithdrawWithinBatch(baseDecimals, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: "Fee for Removing from Liquidity Pool",
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
            })
          );
          break;
        }
        case "/tendermint.liquidity.v1beta1.MsgSwapWithinBatch": {
          const txs = await msgSwapWithinBatch(logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );

          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              description: "Fee for Swapping",
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
              type: "Expense",
            })
          );

          break;
        }
        case "/cosmos.bank.v1beta1.MsgSend": {
          const txs = await msgSend(address, baseSymbol, tx, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "/ibc.applications.transfer.v1.MsgTransfer": {
          const txs = await ibcMsgTransfer(address, baseSymbol, tx, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "/cosmos.gov.v1beta1.MsgVote": {
          const txs = await msgVote(baseSymbol, tx, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "/cosmos.staking.v1beta1.MsgDelegate": {
          const txs = await msgDelegate(address, baseSymbol, tx, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward": {
          const txs = await msgWithdrawDelegatorReward(address, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
              description: "Fees from Claiming Rewards",
            })
          );

          break;
        }

        /* LEGACY ACTION TYPES */
        case "withdraw_delegator_reward": {
          const txs = await legacyWithdrawDelegatorReward(address, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
              description: "Fees from Claiming Rewards",
            })
          );

          break;
        }
        case "send": {
          const txs = await legacySend(address, baseSymbol, tx, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
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

            const tokenAmount = bigDecimal.divide(
              amount,
              getDenominator(baseDecimals),
              baseDecimals
            );

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
              feeAsset: baseSymbol,
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
                      feeAsset: baseSymbol,
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
                    getDenominator(baseDecimals),
                    baseDecimals
                  )} ATOM from ${source?.value} to ${dest?.value}`,
                  feeAmount: await getFees(tx),
                  feeAsset: baseSymbol,
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
                    bigDecimal.divide(
                      value,
                      getDenominator(baseDecimals),
                      baseDecimals
                    )
                  );
                }, "0");

              transactions.push(
                createTransaction({
                  date,
                  transactionHash,
                  transactionId,
                  type: "Income",
                  receivedAmount: amount,
                  receivedAsset: baseSymbol,
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
