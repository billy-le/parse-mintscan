import bigDecimal from "js-big-decimal";
import { getValueOfKey } from "../utils/getValueOfKey";
import { getFees } from "../utils/getFees";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { groupAttributesIntoBlocks } from "../utils/groupAttributesIntoBlocks";
import { getDenominator } from "../utils/getDenominator";

export async function msgVote(baseSymbol: string, tx: Tx, logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  const proposalIds = [];
  for (const { events } of logs) {
    const voteAttributes =
      events.find(({ type }) => type === "proposal_vote")?.attributes ?? [];
    const proposalId = getValueOfKey(voteAttributes, "proposal_id")?.value;
    if (proposalId) {
      proposalIds.push(proposalId);
    }

    for (const { type, attributes } of events) {
      if (type === "claim") {
        const groups = groupAttributesIntoBlocks(attributes);
        for (const group of groups) {
          const amount = group.find(({ key }) => key === "amount");
          if (amount) {
            const denoms = getDenominationsValueList(amount.value);
            for (const [amount, denom] of denoms) {
              const { symbol, decimals } = await getIbcDenomination(denom);
              const tokenAmount = bigDecimal.divide(
                amount,
                getDenominator(decimals),
                decimals
              );
              transactions.push({
                receivedAmount: tokenAmount,
                receivedAsset: symbol,
                type: "Income",
                description: "Airdrop",
              });
            }
          }
        }
      }
    }
  }

  transactions.push({
    type: "Expense",
    feeAmount: await getFees(tx),
    feeAsset: baseSymbol,
    description: `Vote on #${proposalIds.join(" #")}`,
  });

  return transactions;
}
