interface Transaction {
  date: string;
  type?: string;
  sentAsset?: string;
  sentAmount?: string;
  receivedAsset?: string;
  receivedAmount?: string;
  feeAsset?: string;
  feeAmount?: string;
  marketValueCurrency?: string;
  marketValue?: string;
  description?: string;
  transactionHash: string;
  transactionId?: string;
  meta?: string;
}
