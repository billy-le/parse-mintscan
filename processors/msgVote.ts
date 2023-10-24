import { getValueOfKey } from "../utils/getValueOfKey";
import { getFees } from "../utils/getFees";

export async function msgVote(baseSymbol: string, tx: Tx, logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  const proposalIds = [];
  for (const log of logs) {
    const voteAttributes =
      log.events.find(({ type }) => type === "proposal_vote")?.attributes ?? [];
    const proposalId = getValueOfKey(voteAttributes, "proposal_id")?.value;
    if (proposalId) {
      proposalIds.push(proposalId);
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
