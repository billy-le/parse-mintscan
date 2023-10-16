const typeMappings = {
  Deposit: "deposit",
  Expense: "cost",
  Transfer: "withdrawal",
  Swap: "swap",
  Staking: "staking",
  Other: "",
};

function transformTransaction(tx) {
  const { type, feeAsset, feeAmount } = tx;

  switch (type) {
    case "Other": {
      let transactions = [
        {
          ...tx,
          feeAmount: "",
          feeAsset: "",
          type: tx.sentAmount ? "withdrawal" : "deposit",
        },
      ];
      if (tx.feeAmount) {
        transactions.push({
          ...tx,
          sentAmount: feeAmount,
          sentAsset: feeAsset,
          receivedAmount: "",
          receivedAsset: "",
          feeAmount: "",
          feeAsset: "",
          type: "cost",
        });
      }
      return transactions;
    }
    case "Expense": {
      return [
        {
          ...tx,
          sentAmount: feeAmount,
          sentAsset: feeAsset,
          feeAmount: "",
          feeAsset: "",
          type: "cost",
        },
      ];
    }
    case "Swap": {
      return [
        {
          ...tx,
          sentAmount: feeAmount,
          sentAsset: feeAsset,
          receivedAmount: "",
          receivedAsset: "",
          feeAmount: "",
          feeAsset: "",
          type: "cost",
        },
        {
          ...tx,
          feeAmount: "",
          feeAsset: "",
          type: "swap",
        },
      ];
    }
    case "Transfer": {
      return [
        {
          ...tx,
          sentAmount: feeAmount,
          sentAsset: feeAsset,
          feeAmount: "",
          feeAsset: "",
          type: "cost",
        },
        {
          ...tx,
          feeAmount: "",
          feeAsset: "",
          type: "withdrawal",
        },
      ];
    }
    default: {
      return [
        {
          ...tx,
          feeAmount: "",
          feeAsset: "",
          type: typeMappings[type],
        },
      ];
    }
  }
}

module.exports = transformTransaction;
