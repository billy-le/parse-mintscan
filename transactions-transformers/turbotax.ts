function transformTransaction(tx: Transaction): Transaction {
  const {
    date,
    type = "",
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
  } = tx;
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
    meta,
  };
}

export default transformTransaction;
