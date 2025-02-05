// src/actions/perpTrade.ts
import {
  composeContext,
  elizaLogger,
  generateObjectDeprecated,
  ModelClass
} from "@elizaos/core";

// src/types.ts
import { z } from "zod";
var PlaceOrderSchema = z.object({
  symbol: z.string().min(1).toUpperCase(),
  side: z.enum(["Long", "Short"]),
  amount: z.number({ coerce: true }).positive(),
  price: z.number({ coerce: true }),
  nonce: z.string(),
  broker_id: z.enum(["DESK"]),
  order_type: z.enum(["Market", "Limit"]),
  reduce_only: z.boolean(),
  subaccount: z.string(),
  timeInForce: z.enum(["GTC", "IOC", "FOK"]).optional()
});
var CancelOrderSchema = z.object({
  symbol: z.string().min(1).toUpperCase(),
  subaccount: z.string(),
  order_digest: z.string(),
  nonce: z.string(),
  is_conditional_order: z.boolean(),
  wait_for_reply: z.boolean()
});
var DeskExchangeError = class extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "DeskExchangeError";
  }
};

// src/templates.ts
var perpTradeTemplate = `Look at your LAST RESPONSE in the conversation where you confirmed a trade request.
Based on ONLY that last message, extract the trading details:

For DESK Exchange perp trading:
- Market orders (executes immediately at best available price):
  "perp buy 1 HYPE" -> { "symbol": "HYPE", "side": "Long", "amount": "1" }
  "perp sell 2 HYPE" -> { "symbol": "HYPE", "side": "Short", "amount": "2" }
  "perp market buy 1 HYPE" -> { "symbol": "HYPE", "side": "Long", "amount": "1" }
  "perp market sell 2 HYPE" -> { "symbol": "HYPE", "side": "Short", "amount": "2" }

- Limit orders (waits for specified price):
  "buy 1 HYPE at 20 USDC" -> { "symbol": "HYPE", "side": "Long", "amount": "1", "price": "20" }
  "sell 0.5 HYPE at 21 USDC" -> { "symbol": "HYPE", "side": "Short", "amount": "0.5", "price": "21" }
  "limit buy 1 HYPE at 20 USDC" -> { "symbol": "HYPE", "side": "Long", "amount": "1", "price": "20" }
  "limit sell 0.5 HYPE at 21 USDC" -> { "symbol": "HYPE", "side": "Short", "amount": "0.5", "price": "21" }

\`\`\`json
{
    "symbol": "<coin symbol>",
    "side": "<Long for buy, Short for sell>",
    "amount": "<quantity to trade>",
    "price": "<"price in USD if limit order, 0 if market order>"
}
\`\`\`

Note:
- Just use the coin symbol (HYPE, ETH, etc.)
- price is optional:
  - If specified (with "at X USD"), order will be placed at that exact price
  - If not specified, order will be placed at current market price
- Words like "market" or "limit" at the start are optional but help clarify intent

Recent conversation:
{{recentMessages}}`;
var cancelOrderTemplate = `Look at your LAST RESPONSE in the conversation where you confirmed that user want to cancel all orders.

For example:
- I would like to cancel all my orders.
- Cancel all orders
- Cancel orders please

If the user ask to cancel a specific order, please let them know that it is not possible at the moment. Let them know that you now only have the ability to cancel all order only.

Recent conversation:
{{recentMessages}}`;
var accountSummaryTemplate = `Look at ONLY your LAST RESPONSE message in this conversation, where you just confirmed if the user want to check the information of their account.

For example:
- I would like to check the summary of my account on DESK Exchange.
- I want to check the information on my account.
- How is my positions going?
- How is my account?
- Check account summary please

Last part of conversation:
{{recentMessages}}`;

// src/actions/perpTrade.ts
import { ethers } from "ethers";

// src/services/utils.ts
import axios from "axios";
import { randomBytes } from "crypto";
var generateNonce = () => {
  const expiredAt = BigInt(Date.now() + 1e3 * 60) * BigInt(1 << 20);
  const random = parseInt(randomBytes(3).toString("hex"), 16) % (1 << 20);
  return (expiredAt + BigInt(random)).toString();
};
var generateJwt = async (endpoint, wallet, subaccountId, nonce) => {
  const message = `generate jwt for ${wallet.address?.toLowerCase()} and subaccount id ${subaccountId} to trade on happytrading.global with nonce: ${nonce}`;
  const signature = await wallet.signMessage(message);
  const response = await axios.post(
    `${endpoint}/v2/auth/evm`,
    {
      account: wallet.address,
      subaccount_id: subaccountId.toString(),
      nonce,
      signature
    },
    {
      headers: { "content-type": "application/json" }
    }
  );
  if (response.status === 200) {
    return response.data.data.jwt;
  } else {
    throw new DeskExchangeError("Could not generate JWT");
  }
};
var getSubaccount = (account, subaccountId) => {
  const subaccountIdHex = BigInt(subaccountId).toString(16).padStart(24, "0");
  return account.concat(subaccountIdHex);
};
var getEndpoint = (runtime) => {
  return runtime.getSetting("DESK_EXCHANGE_NETWORK") === "mainnet" ? "https://api.happytrading.global" : "https://stg-trade-api.happytrading.global";
};
var formatNumber = (num, decimalPlaces) => {
  return Number(num).toLocaleString(void 0, {
    style: "decimal",
    minimumFractionDigits: 0,
    maximumFractionDigits: decimalPlaces || 8
  });
};

// src/services/trade.ts
import axios2 from "axios";
var placeOrder = async (endpoint, jwt, order) => {
  if (!endpoint || !jwt || !order) {
    throw new Error("Missing required parameters");
  }
  return await axios2.post(`${endpoint}/v2/place-order`, order, {
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json"
    },
    timeout: 5e3,
    validateStatus: (status) => status === 200
  });
};
var cancelOrder = async (endpoint, jwt, order) => {
  if (!endpoint || !jwt || !order) {
    throw new Error("Missing required parameters");
  }
  if (!order.order_digest) {
    throw new Error("Missing order digest");
  }
  return await axios2.post(`${endpoint}/v2/cancel-order`, order, {
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json"
    },
    timeout: 5e3,
    validateStatus: (status) => status === 200
  });
};

// src/actions/perpTrade.ts
var perpTrade = {
  name: "PERP_TRADE",
  similes: ["PERP_ORDER", "PERP_BUY", "PERP_SELL"],
  description: "Place a perpetual contract trade order on DESK Exchange",
  validate: async (runtime) => {
    return !!(runtime.getSetting("DESK_EXCHANGE_PRIVATE_KEY") && runtime.getSetting("DESK_EXCHANGE_NETWORK"));
  },
  handler: async (runtime, message, state, options, callback) => {
    state = !state ? await runtime.composeState(message) : await runtime.updateRecentMessageState(state);
    const context = composeContext({
      state,
      template: perpTradeTemplate
    });
    const content = await generateObjectDeprecated({
      runtime,
      context,
      modelClass: ModelClass.SMALL
    });
    try {
      if (!content) {
        throw new DeskExchangeError(
          "Could not parse trading parameters from conversation"
        );
      }
      const endpoint = getEndpoint(runtime);
      const wallet = new ethers.Wallet(
        runtime.getSetting("DESK_EXCHANGE_PRIVATE_KEY")
      );
      const jwt = await generateJwt(endpoint, wallet, 0, generateNonce());
      elizaLogger.info(
        "Raw content from LLM:",
        JSON.stringify(content, null, 2)
      );
      const processesOrder = {
        symbol: `${content.symbol}USD`,
        side: content.side,
        amount: content.amount,
        price: content.price,
        nonce: generateNonce(),
        broker_id: "DESK",
        order_type: Number(content.price) === 0 ? "Market" : "Limit",
        reduce_only: false,
        subaccount: getSubaccount(wallet.address, 0)
      };
      const parseResult = PlaceOrderSchema.safeParse(processesOrder);
      if (!parseResult.success) {
        throw new Error(
          `Invalid perp trade content: ${JSON.stringify(
            parseResult.error.errors,
            null,
            2
          )}`
        );
      }
      elizaLogger.info(
        "Processed order:",
        JSON.stringify(processesOrder, null, 2)
      );
      const response = await placeOrder(
        endpoint,
        jwt,
        processesOrder
      );
      elizaLogger.info(response.data);
      if (callback && response.status === 200) {
        const orderResponse = response.data.data;
        callback({
          text: `Successfully placed a ${orderResponse.side} ${orderResponse.order_type} order of size ${formatNumber(
            orderResponse.quantity
          )} on ${orderResponse.symbol} at ${orderResponse.order_type === "Market" ? "market price" : formatNumber(orderResponse.price) + " USD"} on DESK Exchange.`,
          content: response.data
        });
      } else {
        callback({
          text: `Place order failed with ${response.data.errors}.`,
          content: response.data
        });
      }
      return true;
    } catch (error) {
      elizaLogger.error("Error executing trade:", {
        content,
        message: error.message,
        code: error.code,
        data: error.response?.data
      });
      if (callback) {
        callback({
          text: `Error executing trade: ${error.message} ${error.response?.data?.errors}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Long 0.1 BTC at 20 USD"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll place a buy order for 0.1 BTC at 20 USD.",
          action: "PERP_TRADE"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Successfully placed a limit order to buy 0.1 BTC at 20 USD"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Short 2 BTC at 21 USD"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll place a sell order for 2 BTC at 21 USD.",
          action: "PERP_TRADE"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Successfully placed a limit order to sell 2 BTC at 21 USD"
        }
      }
    ]
  ]
};

// src/actions/accountSummary.ts
import {
  composeContext as composeContext2,
  elizaLogger as elizaLogger2
} from "@elizaos/core";
import { ethers as ethers2 } from "ethers";

// src/services/account.ts
import axios3 from "axios";
var getSubaccountSummary = async (endpoint, jwt, subaccount) => {
  if (!endpoint || !jwt || !subaccount) {
    throw new Error("Missing required parameters");
  }
  return await axios3.get(`${endpoint}/v2/subaccount-summary/${subaccount}`, {
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json"
    },
    timeout: 5e3,
    validateStatus: (status) => status === 200
  });
};

// src/actions/accountSummary.ts
var accountSummary = {
  name: "GET_PERP_ACCOUNT_SUMMARY",
  similes: [
    "CHECK_ACCOUNT",
    "CHECK_PERP_ACCOUNT",
    "ACCOUNT_SUMMARY",
    "PERP_ACCOUNT_SUMMARY"
  ],
  description: "Get the current account summary",
  validate: async (runtime) => {
    return !!(runtime.getSetting("DESK_EXCHANGE_PRIVATE_KEY") && runtime.getSetting("DESK_EXCHANGE_NETWORK"));
  },
  handler: async (runtime, message, state, options, callback) => {
    state = !state ? await runtime.composeState(message) : await runtime.updateRecentMessageState(state);
    const context = composeContext2({
      state,
      template: accountSummaryTemplate
    });
    try {
      const endpoint = getEndpoint(runtime);
      const wallet = new ethers2.Wallet(
        runtime.getSetting("DESK_EXCHANGE_PRIVATE_KEY")
      );
      const jwt = await generateJwt(endpoint, wallet, 0, generateNonce());
      const response = await getSubaccountSummary(
        endpoint,
        jwt,
        getSubaccount(wallet.address, 0)
      );
      elizaLogger2.info(response.data);
      const subaccountSummaryData = response.data.data;
      const positionSummary = subaccountSummaryData.positions.length > 0 ? subaccountSummaryData.positions.map((p) => {
        return `- ${p.side} ${formatNumber(p.quantity)} ${p.symbol}`;
      }).join("\n") : "- No active position";
      const orderSummary = subaccountSummaryData.open_orders.length > 0 ? subaccountSummaryData.open_orders.map((o) => {
        return `- ${o.side === "Long" ? "Buy" : "Sell"} ${formatNumber(
          Number(o.original_quantity) - Number(o.remaining_quantity)
        )}/${formatNumber(o.original_quantity)} ${o.symbol} @${Number(o.price) > 0 ? formatNumber(o.price) : formatNumber(o.trigger_price)}`;
      }).join("\n") : "- No orders";
      const collateralSummary = subaccountSummaryData.collaterals.length > 0 ? subaccountSummaryData.collaterals.map((c) => {
        return `- ${formatNumber(c.amount, 4)} ${c.asset}`;
      }).join("\n") : "- No collateral";
      callback({
        text: `Here is the summary of your account ${wallet.address}
Your positions:
` + positionSummary + `
Your orders:
` + orderSummary + `
Your collaterals:
` + collateralSummary,
        content: subaccountSummaryData
      });
      return true;
    } catch (error) {
      elizaLogger2.error("Error getting account summary:", {
        message: error.message,
        code: error.code,
        data: error.response?.data
      });
      if (callback) {
        callback({
          text: `Error getting account summary: ${error.message} ${error.response?.data?.errors}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Check my account please"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Here is the summary of your account",
          action: "GET_PERP_ACCOUNT_SUMMARY"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "How is my account doing?"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Here is the summary of your account",
          action: "GET_PERP_ACCOUNT_SUMMARY"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Account summary"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Here is the summary of your account",
          action: "GET_PERP_ACCOUNT_SUMMARY"
        }
      }
    ]
  ]
};
var accountSummary_default = accountSummary;

// src/actions/cancelOrders.ts
import {
  elizaLogger as elizaLogger3,
  composeContext as composeContext3
} from "@elizaos/core";
import { ethers as ethers3 } from "ethers";
var cancelOrders = {
  name: "CANCEL_ORDERS",
  similes: ["CANCEL_ALL_ORDERS", "CANCEL", "CANCEL_ALL"],
  description: "Cancel all open orders on DESK Exchange",
  validate: async (runtime) => {
    return !!(runtime.getSetting("DESK_EXCHANGE_PRIVATE_KEY") && runtime.getSetting("DESK_EXCHANGE_NETWORK"));
  },
  handler: async (runtime, message, state, options, callback) => {
    state = !state ? await runtime.composeState(message) : await runtime.updateRecentMessageState(state);
    const context = composeContext3({
      state,
      template: cancelOrderTemplate
    });
    try {
      const endpoint = getEndpoint(runtime);
      const wallet = new ethers3.Wallet(
        runtime.getSetting("DESK_EXCHANGE_PRIVATE_KEY")
      );
      const jwt = await generateJwt(endpoint, wallet, 0, generateNonce());
      const subaccountSummaryResponse = await getSubaccountSummary(
        endpoint,
        jwt,
        getSubaccount(wallet.address, 0)
      );
      const openOrders = subaccountSummaryResponse.data?.data?.open_orders;
      if (openOrders && openOrders.length > 0) {
        for (const o of openOrders) {
          await cancelOrder(endpoint, jwt, {
            symbol: o.symbol,
            subaccount: getSubaccount(wallet.address, 0),
            order_digest: o.order_digest,
            nonce: generateNonce(),
            is_conditional_order: false,
            wait_for_reply: false
          });
        }
        callback({
          text: `Successfully cancelled ${openOrders.length} orders.`
        });
      }
      return true;
    } catch (error) {
      elizaLogger3.error("Error canceling orders:", {
        message: error.message,
        code: error.code,
        data: error.response?.data
      });
      if (callback) {
        callback({
          text: `Error canceling orders: ${error.message} ${error.response?.data?.errors}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Cancel all my orders"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll cancel all your open orders.",
          action: "CANCEL_ORDERS"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Successfully cancelled 2 open orders"
        }
      }
    ]
  ]
};
var cancelOrders_default = cancelOrders;

// src/index.ts
var deskExchangePlugin = {
  name: "deskExchange",
  description: "DESK Exchange plugin",
  actions: [perpTrade, accountSummary_default, cancelOrders_default],
  providers: [],
  evaluators: [],
  services: [],
  clients: []
};
var index_default = deskExchangePlugin;
export {
  index_default as default,
  deskExchangePlugin
};
//# sourceMappingURL=index.js.map