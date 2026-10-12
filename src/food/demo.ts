/**
 * An in-memory DoorDash for tests and for trying the flow without a DoorDash session (FOOD_PROVIDER=demo, the deployed
 * default): five restaurants that deliver anywhere, real-looking menus, and DoorDash-style fees. Every order goes
 * through unless a test scripts another outcome; nothing is ever bought or delivered.
 *
 * Pricing: subtotal, the restaurant's delivery fee, a 15% service fee (at least $3.00), 8.625% tax on the subtotal and
 * the tip, all rounded to the cent, the way a DoorDash checkout lists them.
 */
import { randomBytes } from "node:crypto";
import type { Outcome } from "../merchant.js";
import { checkLines, FoodError, type FoodOrder, type FoodProvider, type FoodQuote, type MenuItem, type Restaurant, tipCents } from "./provider.js";

export interface DemoRestaurant extends Omit<Restaurant, "url"> {
  menu: MenuItem[];
}

const SERVICE_RATE = 0.15;
const SERVICE_MIN_CENTS = 300;
const TAX_RATE = 0.08625;

const item = (itemId: string, name: string, priceCents: number, section: string, description?: string): MenuItem => ({ itemId, name, priceCents, section, ...(description ? { description } : {}) });

export const DEMO_RESTAURANTS: DemoRestaurant[] = [
  {
    storeId: "1000101", name: "Chipotle Mexican Grill", cuisine: "Mexican", rating: "4.6", etaMinutes: 25, deliveryFeeCents: 199,
    menu: [
      item("2000101", "Burrito Bowl", 1195, "Bowls", "Rice, beans, your choice of protein, salsa and toppings"),
      item("2000102", "Burrito", 1195, "Burritos", "A flour tortilla with rice, beans, protein, salsa and toppings"),
      item("2000103", "Tacos (3)", 1095, "Tacos"),
      item("2000104", "Chips & Guacamole", 545, "Sides"),
      item("2000105", "Chips", 245, "Sides"),
      item("2000106", "Mexican Coca-Cola", 375, "Drinks"),
    ],
  },
  {
    storeId: "1000202", name: "Sweetgreen", cuisine: "Salads", rating: "4.7", etaMinutes: 30, deliveryFeeCents: 299,
    menu: [
      item("2000201", "Harvest Bowl", 1545, "Bowls", "Chicken, sweet potatoes, apples, goat cheese, almonds, wild rice, kale"),
      item("2000202", "Kale Caesar", 1295, "Salads"),
      item("2000203", "Shroomami", 1475, "Bowls"),
      item("2000204", "Crispy Rice Bowl", 1595, "Bowls"),
      item("2000205", "Rosemary Focaccia", 345, "Sides"),
      item("2000206", "Hibiscus Lemonade", 445, "Drinks"),
    ],
  },
  {
    storeId: "1000303", name: "Joe's Pizza", cuisine: "Pizza", rating: "4.8", etaMinutes: 35, deliveryFeeCents: 99,
    menu: [
      item("2000301", "Cheese Slice", 450, "Slices"),
      item("2000302", "Pepperoni Slice", 525, "Slices"),
      item("2000303", "Large Cheese Pie", 2600, "Pies", "18 inch"),
      item("2000304", "Large Pepperoni Pie", 3050, "Pies", "18 inch"),
      item("2000305", "Garlic Knots (6)", 695, "Sides"),
      item("2000306", "Caesar Salad", 995, "Sides"),
    ],
  },
  {
    storeId: "1000404", name: "Sakura Sushi", cuisine: "Japanese", rating: "4.5", etaMinutes: 40, deliveryFeeCents: 299,
    menu: [
      item("2000401", "California Roll", 895, "Rolls"),
      item("2000402", "Spicy Tuna Roll", 1095, "Rolls"),
      item("2000403", "Salmon Nigiri (2 pc)", 795, "Nigiri"),
      item("2000404", "Chirashi Bowl", 2495, "Bowls", "Chef's choice of sashimi over sushi rice"),
      item("2000405", "Miso Soup", 395, "Sides"),
      item("2000406", "Edamame", 595, "Sides"),
    ],
  },
  {
    storeId: "1000505", name: "Thai Basil Kitchen", cuisine: "Thai", rating: "4.6", etaMinutes: 35, deliveryFeeCents: 0,
    menu: [
      item("2000501", "Pad Thai", 1595, "Noodles", "Rice noodles, egg, tofu, bean sprouts, peanuts"),
      item("2000502", "Pad See Ew", 1595, "Noodles"),
      item("2000503", "Green Curry", 1695, "Curries"),
      item("2000504", "Tom Yum Soup", 1295, "Soups"),
      item("2000505", "Spring Rolls (4)", 795, "Appetizers"),
      item("2000506", "Thai Iced Tea", 495, "Drinks"),
    ],
  },
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const demoStoreUrl = (r: Pick<Restaurant, "storeId" | "name">): string => `https://www.doordash.com/store/${slug(r.name)}-${r.storeId}/`;

/** The demo's checkout math for `order` at `restaurant`, or why it cannot be ordered. */
export function demoPrice(restaurant: DemoRestaurant, order: FoodOrder): Omit<FoodQuote, "quoteId" | "expiresAt"> {
  const items = checkLines(order.items).map((line) => {
    const found = restaurant.menu.find((m) => m.itemId === line.itemId);
    if (!found) throw new FoodError(`${restaurant.name} has no item ${line.itemId}; use an item_id from doordash_menu`);
    return { itemId: found.itemId, name: found.name, quantity: line.quantity, unitCents: found.priceCents };
  });
  const subtotalCents = items.reduce((sum, i) => sum + i.unitCents * i.quantity, 0);
  const feesCents = (restaurant.deliveryFeeCents ?? 0) + Math.max(SERVICE_MIN_CENTS, Math.round(subtotalCents * SERVICE_RATE));
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const tip = tipCents(subtotalCents, order.tipPercent);
  return {
    storeId: restaurant.storeId,
    restaurant: restaurant.name,
    items,
    subtotalCents,
    feesCents,
    taxCents,
    tipCents: tip,
    totalCents: subtotalCents + feesCents + taxCents + tip,
    address: order.address,
    tipPercent: order.tipPercent,
    ...(restaurant.etaMinutes ? { etaMinutes: restaurant.etaMinutes } : {}),
  };
}

export function demoDoorDash(
  restaurants: DemoRestaurant[] = structuredClone(DEMO_RESTAURANTS),
  options: { quoteTtlMs?: number; onConfirm?: (quote: FoodQuote) => Outcome | undefined } = {},
): FoodProvider & { restaurants: DemoRestaurant[]; confirmed: FoodQuote[] } {
  let seq = 0;
  const confirmed: FoodQuote[] = [];
  const store = (storeId: string) => restaurants.find((r) => r.storeId === storeId.trim());
  return {
    name: "DoorDash",
    restaurants,
    confirmed,
    async searchRestaurants(query, _near, limit = 5) {
      // Every word of the query against the name, the cuisine and the menu; nothing matches: everything, best rated first.
      const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !["food", "the", "and", "some", "delivery", "near"].includes(w));
      const text = (r: DemoRestaurant) => [r.name, r.cuisine ?? "", ...r.menu.map((m) => m.name)].join(" ").toLowerCase();
      const score = (r: DemoRestaurant) => words.filter((w) => text(r).includes(w)).length;
      const hits = restaurants.filter((r) => score(r) > 0);
      const pool = hits.length ? hits.sort((a, b) => score(b) - score(a)) : [...restaurants].sort((a, b) => Number(b.rating ?? 0) - Number(a.rating ?? 0));
      return pool.slice(0, limit).map(({ menu: _menu, ...r }) => ({ ...r, url: demoStoreUrl(r) }));
    },
    async menu(storeId) {
      const r = store(storeId);
      if (!r) throw new FoodError(`DoorDash has no store ${storeId}; use a store_id from search_doordash`);
      return r.menu.map((m) => ({ ...m }));
    },
    async quote(order) {
      const r = store(order.storeId);
      if (!r) throw new FoodError(`DoorDash has no store ${order.storeId}; use a store_id from search_doordash`);
      return { ...demoPrice(r, order), quoteId: `demo-fq${++seq}`, expiresAt: Date.now() + (options.quoteTtlMs ?? 20 * 60_000) };
    },
    async confirm(quote) {
      const r = store(quote.storeId);
      if (!r) return { status: "no_purchase", reason: "the restaurant is closed" };
      let now;
      try {
        now = demoPrice(r, { storeId: quote.storeId, items: quote.items, address: quote.address, tipPercent: quote.tipPercent });
      } catch {
        return { status: "no_purchase", reason: "an item is no longer available" };
      }
      if (now.totalCents !== quote.totalCents) return { status: "no_purchase", reason: "price changed" };
      confirmed.push(quote);
      return options.onConfirm?.(quote) ?? { status: "ordered", orderId: randomBytes(4).toString("hex").toUpperCase(), totalCents: quote.totalCents, ...(quote.etaMinutes ? { etaMinutes: quote.etaMinutes } : {}) };
    },
    async close() {},
  };
}
