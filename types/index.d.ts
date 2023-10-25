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
      | string
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
      | "fungible_token_packet"
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

type IOBTxInfo = {
  tx_hash: string;
  status: number;
  time: number;
  height: number;
  type: string;
  memo: string;
  fee: {
    amount: Array<{
      denom: string;
      amount: string;
    }>;
    gas: number;
  };
  signers: string[];
  timeout_height: string;
  timeout_timestamp: number;
  ack: string;
  proof_height: string;
  next_sequence_recv: number;
};

type IOBResponseBody = {
  code: number;
  message: "success";
  data: {
    is_list: boolean;
    sc_info: {
      address: string;
      chain: string;
      channel_id: string;
      port_id: string;
      connection_id: string;
      client_id: string;
    };
    dc_info: {
      address: string;
      chain: string;
      channel_id: string;
      port_id: string;
      connection_id: string;
      client_id: string;
    };
    token_info: {
      base_denom: string;
      base_denom_chain: string;
      send_token: {
        denom: string;
        denom_path: string;
      };
      recv_token: {
        denom: string;
        denom_path: string;
      };
      amount: string;
    };
    relayer_info: {
      sc_relayer: {
        relayer_name: string;
        icon: string;
        relayer_addr: string;
      };
      dc_relayer: {
        relayer_name: string;
        icon: string;
        relayer_addr: string;
      };
    };
    ibc_tx_info: {
      sc_tx_info: IOBTxInfo | null;
      dc_tx_info: IOBTxInfo | null;
      ack_timeout_tx_info: IOBTxInfo | null;
    };
    status: number;
    sequence: string;
    error_log: string;
    time_stamp: number;
  };
};
