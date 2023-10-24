// utils
import { format as dateFormat, parseISO } from "date-fns";
import { getFees } from "./utils/getFees";
import { createTransaction } from "./utils/createTransaction";

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
import { legacyDelegate } from "./processors/legacyDelegate";
import { legacyVote } from "./processors/legacyVote";
import { legacySwapWithinBatch } from "./processors/legacySwapWithinBatch";
import { legacyDepositWithinBatch } from "./processors/legacyDepositWithinBatch";
import { legacyBeginRedelegate } from "./processors/legacyBeginRedelegate";
import { wasmMessageExecuteContract } from "./processors/wasmMsgExecuteContract";
import { recvPacket } from "./processors/recv_packet";
import { lockTokens } from "./processors/lockTokens";
import { osmosisMsgJoinPool } from "./processors/osmosisMsgJoinPool";
import { osmosisMsgJoinSwapExternAmountIn } from "./processors/osmosisMsgJoinSwapExternAmountIn";
import { osmosisMsgSwapExactAmountIn } from "./processors/osmosisMsgSwapExactAmountIn";
import { osmosisMsgExitPool } from "./processors/osmosMsgExitPool";
import { msgMultiSend } from "./processors/msgMultiSend";

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
    tx: Tx;
    logs: Log[];
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
        } else {
          console.log(">>> Logs has no actions!");
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
          // console.log(action);
          break;
        }
        case "/osmosis.superfluid.MsgSuperfluidUndelegate": {
          break;
        }
        case "/osmosis.superfluid.MsgSuperfluidUnbondLock": {
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: "Fee for Superfluid Unbond and Undelegate",
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
            })
          );

          break;
        }
        case "/cosmos.bank.v1beta1.MsgMultiSend": {
          const txs = await msgMultiSend(address, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "superfluid_delegate": {
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: "Superfluid Delegate",
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
            })
          );
          break;
        }
        case "/osmosis.gamm.v1beta1.MsgExitPool": {
          const txs = await osmosisMsgExitPool(logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            ),
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: "Fee for Exiting Liquidity Pool",
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
            })
          );
          break;
        }
        case "/osmosis.lockup.MsgBeginUnlocking": {
          // payload doesn't give info on which coins are unbonding
          transactions.push(
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: "Fee from Unbonding Liquidity",
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
            })
          );
          break;
        }
        case "/osmosis.gamm.v1beta1.MsgSwapExactAmountIn": {
          const txs = await osmosisMsgSwapExactAmountIn(logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            ),
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: "Fee from Swapping",
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
            })
          );
          break;
        }
        case "/osmosis.gamm.v1beta1.MsgJoinSwapExternAmountIn": {
          const txs = await osmosisMsgJoinSwapExternAmountIn(logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            ),
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: "Fee from Adding to Liquidity Pool",
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
            })
          );
          break;
        }
        case "/osmosis.gamm.v1beta1.MsgJoinPool": {
          const txs = await osmosisMsgJoinPool(logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            ),
            createTransaction({
              date,
              transactionHash,
              transactionId,
              type: "Expense",
              description: `Fees for Joining Pool`,
              feeAmount: await getFees(tx),
              feeAsset: baseSymbol,
            })
          );

          break;
        }
        case "lock_tokens": {
          const txs = await lockTokens(address, baseSymbol, tx, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "recv_packet": {
          const txs = await recvPacket(address, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "/ibc.core.client.v1.MsgUpdateClient":
        case "/ibc.core.channel.v1.MsgAcknowledgement": {
          break;
        }
        case "/cosmwasm.wasm.v1.MsgExecuteContract": {
          const txs = await wasmMessageExecuteContract(
            address,
            baseSymbol,
            tx,
            logs
          );
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
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
            ),
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
            ),
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
          const txs = await msgDelegate(baseSymbol, tx, logs);
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
            ),
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
            ),
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
          const txs = await legacyDelegate(address, baseDecimals, tx, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "vote": {
          const txs = await legacyVote(tx, logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }

        case "swap_within_batch": {
          const txs = await legacySwapWithinBatch(logs);
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            ),
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
          const txs = await legacyDepositWithinBatch(
            address,
            baseSymbol,
            tx,
            logs
          );
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
        case "begin_redelegate": {
          const txs = await legacyBeginRedelegate(
            baseSymbol,
            baseDecimals,
            tx,
            logs
          );
          transactions.push(
            ...txs.map((tx) =>
              createTransaction({ ...tx, date, transactionHash, transactionId })
            )
          );
          break;
        }
      }
    }
  }

  return transactions.map((tx) => Object.values(tx).join(",") + "\n").join("");
}

export default processTransaction;
