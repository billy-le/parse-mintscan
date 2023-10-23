import { getValueOfKey } from "../utils/getValueOfKey";
import { getFees } from "../utils/getFees";

export async function legacyVote(tx: Tx, logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const log of logs) {
    const voteAttributes =
      log.events.find(({ type }) => type === "proposal_vote")?.attributes ?? [];
    const proposalId = getValueOfKey(voteAttributes, "proposal_id")?.value;

    transactions.push({
      type: "Expense",
      feeAmount: await getFees(tx),
      description: `Vote on #${proposalId}`,
    });
  }
  return transactions;
}
