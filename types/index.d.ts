interface Transaction {
  date: string;
  type?:
    | "Expense"
    | "Staking"
    | "Transfer"
    | "Income"
    | "Deposit"
    | "Swap"
    | "Other";
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

type Log = {
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
      | "recv_packet"
      | "lock_tokens"
      | "superfluid_delegate"
      | "token_swapped"
      | "pool_exited"
      | "/cosmos.bank.v1beta1.MsgMultiSend"
      | "cosmos.authz.v1beta1.EventGrant"
      | "cosmos.authz.v1beta1.EventRevoke"
      // OSMOSIS actions
      | "/osmosis.lockup.MsgBeginUnlocking"
      | "/osmosis.gamm.v1beta1.MsgSwapExactAmountIn"
      | "/osmosis.gamm.v1beta1.MsgJoinSwapExternAmountIn"
      | "/osmosis.gamm.v1beta1.MsgJoinPool"
      | "/osmosis.superfluid.MsgSuperfluidUnbondLock"
      | "/osmosis.lockup.MsgBeginUnlocking"
      | "/osmosis.gamm.v1beta1.MsgExitPool";
    attributes: Array<{
      key: string;
      value: string;
      ["value__@transfer"]?: any;
    }>;
  }>;
};

type TxType = Record<
  string,
  {
    body: {
      messages: any[];
    };
    auth_info: {
      fee: {
        amount: Array<{ denom: string; amount: string }>;
        gas_limit: string;
        payer: string;
        granter: string;
      };
    };
  }
>;

type Tx = Record<"@type", string> | TxType;
