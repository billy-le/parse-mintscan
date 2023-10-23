import { getFees } from "../utils/getFees";

export async function wasmMessageExecuteContract(
  address: string,
  baseSymbol: string,
  tx: Tx,
  logs: Log[]
) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    for (const { type, attributes } of events) {
      if (type === "wasm") {
        const attrLen = attributes.length;
        const groups: Array<Array<{ key: string; value: string }>> = [];

        for (let i = 0; i < attrLen; ) {
          const startKey = attributes[i].key;
          for (let j = i + 1; j < attrLen; j++) {
            const compareKey = attributes[j].key;
            if (startKey === compareKey) {
              const group = attributes.slice(i, j);
              i = j - 1;
              groups.push(group);
              break;
            }
            if (j === attrLen - 1) {
              const group = attributes.slice(i, j + 1);
              groups.push(group);
              i = attrLen;
              break;
            }
          }
          i++;
        }

        for (const group of groups) {
          const action = group.find(({ key }) => key === "action")?.value;
          switch (action) {
            case "bond": {
              // ignore bond since it's in the same group as delegate
              break;
            }
            case "delegate": {
              const [
                { value: contractAddress },
                ,
                { value: fromAddress },
                { value: toAddress },
                { value: amount },
              ] = group;

              if (fromAddress === address) {
                transactions.push({
                  type: "Expense",
                  description: `Delegate to ${toAddress}`,
                  feeAsset: baseSymbol,
                  feeAmount: await getFees(tx),
                });
              }

              break;
            }
            case "mint": {
              const [
                { value: contractAddress },
                { value: depositToken1Amount },
                { value: depositToken2Amount },
                { value: liquidityTokenAmountReceived },
              ] = groups
                .filter((group) =>
                  group.find(({ key }) => key === "liquidity_received")
                )
                .flat();
              transactions.push({
                sentAmount: depositToken1Amount,
                sentAsset: "Token 1",
              });
              transactions.push({
                sentAmount: depositToken2Amount,
                sentAsset: "Token 2",
              });
              transactions.push({
                receivedAmount: liquidityTokenAmountReceived,
                receivedAsset: "Pool Token",
              });
              break;
            }
            case "transfer": {
              // ignore, used with claim
              break;
            }
            case "claim": {
              const [{ value: contractAddress }] = group;
              const amount = group.find(({ key }) => key === "amount")?.value;
              transactions.push({
                receivedAmount: amount,
                receivedAsset: contractAddress,
                type: "Income",
                description: `Claimed Airdrop from ${contractAddress}`,
              });
              break;
            }
            case "vote": {
              const [{ value: contractAddress }, , , { value: proposalId }] =
                group;
              transactions.push({
                type: "Expense",
                feeAmount: await getFees(tx),
                feeAsset: baseSymbol,
                description: `Vote on ${contractAddress} #${proposalId}`,
              });
              break;
            }
            case "send": {
              // ignore, used with stake
              break;
            }
            case "stake": {
              const [
                { value: contractAddress },
                ,
                { value: fromAddress },
                { value: toAddress },
                { value: amount },
              ] = groups
                .filter((group) =>
                  group.find(
                    ({ key, value }) => key === "action" && value === "send"
                  )
                )
                .flat();

              if (fromAddress === address) {
                transactions.push({
                  type: "Expense",
                  feeAmount: await getFees(tx),
                  feeAsset: baseSymbol,
                  description: `Staked ${amount} to ${toAddress}`,
                });
              }

              break;
            }
            case "unstake": {
              const [
                { value: contractAddress },
                ,
                { value: fromAddress },
                { value: amount },
              ] = group;
              if (fromAddress === address) {
                transactions.push({
                  type: "Expense",
                  feeAmount: await getFees(tx),
                  feeAsset: baseSymbol,
                  description: `Unstake ${amount} from ${fromAddress}`,
                });
              }
              break;
            }
            case "withdraw_rewards": {
              const [
                { value: contractAddress },
                ,
                ,
                ,
                { value: receiver },
                { value: amount },
              ] = group;
              if (receiver === address) {
                transactions.push({
                  receivedAmount: amount,
                  receivedAsset: contractAddress,
                  description: "Claimed Rewards",
                  feeAmount: await getFees(tx),
                  feeAsset: baseSymbol,
                  type: "Income",
                });
              }
              break;
            }
            case "increase_allowance": {
              // ignore, used with `transfer_from`
              break;
            }
            case "transfer_from": {
              const [
                [, , { value: demandTokenAmount }],
                [
                  { value: contractAddress },
                  ,
                  { value: fromAddress },
                  { value: toAddress },
                  ,
                  { value: offerTokenAmount },
                ],
              ] = groups;

              if (fromAddress === address) {
                transactions.push({
                  type: "Swap",
                  sentAmount: offerTokenAmount,
                  sentAsset: contractAddress,

                  // TODO - change later when we get demand token from contract address
                  receivedAmount: demandTokenAmount,
                  receivedAsset: baseSymbol,
                  description: `Swapped ${offerTokenAmount} ${contractAddress} for ${demandTokenAmount} ${baseSymbol}`,
                });

                transactions.push({
                  type: "Expense",
                  feeAmount: await getFees(tx),
                  feeAsset: baseSymbol,
                  description: `Fees from swapping`,
                });
              }

              break;
            }
            default: {
              break;
            }
          }
        }
      }
    }
  }
  return transactions;
}
