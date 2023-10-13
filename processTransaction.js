const fs = require("fs");
const util = require("util");
const currency = require("currency.js");
const { exec } = require("child_process");
const { format: dateFormat, parseISO } = require("date-fns");
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
    console.error(err);
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
  };
}

function getFees(tx) {
  const { auth_info } = getModuleType(tx);
  const fee = auth_info.fee.amount[0];
  return currency(fee.amount, { precision: 8 }).divide(denominator).value;
}

async function processTransaction(
  address,
  { txhash: transactionHash, id: transactionId, timestamp, tx, logs, ...rest }
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

  for (const type in msgTypeGroup) {
    switch (type) {
      case "/cosmos.gov.v1beta1.MsgVote": {
        let proposals = [];

        for (let i = 0; i < msgTypeGroup[type].length; i++) {
          const msg = msgTypeGroup[type][i];
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
      case "/ibc.core.channel.v1.MsgTimeout": {
        createTransaction({
          date,
          transactionHash,
          transactionId,
        });
        break;
      }
      case "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward": {
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

        for (const key in tokens) {
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              receivedAsset: key.toUpperCase(),
              receivedAmount: tokens[key].value,
              description: "Claim Rewards",
              type: "Staking",
              feeAsset: "",
            })
          );
        }
        break;
      }
      case "/cosmos.staking.v1beta1.MsgDelegate": {
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
        const messages = msgTypeGroup[type];
        for (const msg of messages) {
          const token = await getIbcDenomination(msg.token.denom);
          const sentAmount = currency(msg.token.amount, {
            precision: 8,
          }).divide(denominator).value;
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Transfer",
              sentAsset: token,
              sentAmount,
              feeAmount: getFees(tx),
            })
          );
        }
        break;
      }
      case "/ibc.core.client.v1.MsgUpdateClient": {
        break;
      }
      case "/ibc.core.channel.v1.MsgAcknowledgement": {
        break;
      }
      case "/ibc.core.channel.v1.MsgRecvPacket": {
        // console.log(transactionHash);
        for (const msg of msgTypeGroup[type]) {
          const packetData = msg.packet["data__@parse__@transfer"];
          if (packetData.receiver === address) {
            const matchedLog = logs.find((log) =>
              log.events.some((event) =>
                event.attributes.some((attr) => attr.value === type)
              )
            );
            if (matchedLog) {
              const event = matchedLog.events.find(
                (event) => event.type === "coin_received"
              );
              if (event) {
                const eventObj = event.attributes.find(
                  (attr) => attr.key === "amount"
                );
                if (eventObj) {
                  const tokens = eventObj.value.split(",");
                  for (const token of tokens) {
                    if (token.includes("uatom")) {
                      const [tokenValue] = token.split("uatom");
                      const amount =
                        currency(tokenValue).divide(denominator).value;
                      transactions.push(
                        createTransaction({
                          date,
                          transactionHash,
                          transactionId,
                          type: "Deposit",
                          receivedAmount: amount,
                          receivedAsset: "ATOM",
                          feeAsset: "",
                        })
                      );
                    } else if (token.includes("ibc/")) {
                      const [tokenValue] = token.split("ibc/");
                      const ibcToken = await getIbcDenomination(token);
                      const amount =
                        currency(tokenValue).divide(denominator).value;
                      transactions.push(
                        createTransaction({
                          date,
                          transactionHash,
                          transactionId,
                          type: "Deposit",
                          receivedAmount: amount,
                          receivedAsset: ibcToken,
                          feeAsset: "",
                        })
                      );
                    }
                  }
                }
              }
            }
          } else if (packetData.sender === address) {
            // console.log(msg)
          }
        }
        break;
      }
      case "/cosmos.bank.v1beta1.MsgSend": {
        for (const msg of msgTypeGroup[type]) {
          let amount = currency(0, { precision: 8 });
          if (msg.to_address === address) {
            for (const am of msg.amount) {
              if (am.denom === "uatom") {
                amount = amount.add(currency(am.amount, { precision: 8 }));

                transactions.push(
                  createTransaction({
                    date,
                    transactionHash,
                    transactionId,
                    type: "Deposit",
                    receivedAsset: "ATOM",
                    receivedAmount: amount.divide(denominator).value,
                    feeAsset: "",
                  })
                );
              } else {
                const token = await getIbcDenomination(am.denom);
                amount = amount.add(currency(am.amount, { precision: 8 }));

                transactions.push(
                  createTransaction({
                    date,
                    transactionHash,
                    transactionId,
                    type: "Income",
                    receivedAsset: token,
                    receivedAmount: amount.divide(denominator).value,
                    feeAsset: "",
                  })
                );
              }
            }
          } else if (msg.from_address === address) {
            for (const am of msg.amount) {
              amount = amount.add(currency(am.amount, { precision: 8 }));
            }

            transactions.push(
              createTransaction({
                date,
                transactionHash,
                transactionId,
                type: "Withdrawal",
                sentAsset: "ATOM",
                sentAmount: amount.divide(denominator).value,
                feeAmount: getFees(tx),
              })
            );
          }
        }
        break;
      }
      case "/ibc.core.channel.v1.MsgTimeout": {
        break;
      }
      case "/tendermint.liquidity.v1beta1.MsgSwapWithinBatch": {
        break;
      }
      case "/tendermint.liquidity.v1beta1.MsgWithdrawWithinBatch": {
        break;
      }
      case "/tendermint.liquidity.v1beta1.MsgDepositWithinBatch": {
        break;
      }
    }
  }

  return transactions.map((tx) => Object.values(tx).join(",") + ",\n").join("");
}

module.exports = processTransaction;
