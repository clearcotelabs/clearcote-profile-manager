// Examples of what Jet can do, shown in Run a task (chips and "More examples…") and on the Tasks page (a
// gallery). One click fills the goal and, when it is empty, the start page.
//
// Titles and categories are UI text (marked with tx(), translated where shown). Goals are what Jet's model
// reads, so they stay in English like every goal typed in the dialog. A goal is written the way a person
// would ask, ends with what "done" looks like, and uses {{slots}} for what differs per profile or per run.
// Kept to what a browser agent does well: logging in, forms (dropdowns, date pickers, sliders, autocomplete),
// searching and paging, reading a value off a page, cart and wishlist without checking out, a table row's
// menu, a confirm dialog. Nothing that solves captchas, pays, posts in bulk, collects people's data or inflates
// numbers across accounts (follows, votes, one coupon or one quote from many profiles: no "same for all" there).

import { tx } from "./i18n";
import { templateSlots } from "../../electron/jetslots";

/** Where a slot's value comes from in Run a task (TaskParam["source"]). */
type Source = "profile" | "run";

export const EXAMPLE_CATEGORIES = [
  { id: "accounts", title: tx("Accounts & logins") },
  { id: "shopping", title: tx("Shopping & prices") },
  { id: "forms", title: tx("Forms & sign-ups") },
  { id: "reading", title: tx("Reading & monitoring") },
  { id: "social", title: tx("Social & messaging") },
  { id: "admin", title: tx("Admin & back-office") },
  { id: "research", title: tx("Search & research") },
] as const;

export type ExampleCategory = (typeof EXAMPLE_CATEGORIES)[number]["id"];

export interface TaskExample {
  id: string;
  category: ExampleCategory;
  /** Shown on the chip or card; translate with t(). */
  title: string;
  /** What Jet is asked to do (English, model-facing). */
  goal: string;
  /** Start page; "https://" when it depends on the site the user means. */
  url: string;
  /** Slots that are naturally the same for every profile in a run (a search term, a date): picking the
   *  example sets them to "Same for all" instead of each profile's own value. */
  same?: string[];
}

export const TASK_EXAMPLES: TaskExample[] = [
  // Accounts & logins
  {
    id: "login-inbox",
    category: "accounts",
    title: tx("Log in"),
    goal: "Log in with {{email}} and the password {{password}}, then open the inbox and tell me how many unread messages there are",
    url: "https://",
  },
  {
    id: "stay-signed-in",
    category: "accounts",
    title: tx("Sign in and stay signed in"),
    goal: "Sign in with {{email}} and {{password}}, tick \"Keep me signed in\" if the form has it, and stop when the account dashboard is showing",
    url: "https://",
  },
  {
    id: "display-name",
    category: "accounts",
    title: tx("Change the display name"),
    goal: "Open the profile settings, change the display name to {{display_name}}, save, and check that the page shows the new name",
    url: "https://",
  },
  {
    id: "marketing-off",
    category: "accounts",
    title: tx("Turn off marketing emails"),
    goal: "Open the account's notification settings, switch off every marketing and newsletter email but keep security alerts on, save, then tell me what you changed",
    url: "https://",
  },
  {
    id: "renewal-date",
    category: "accounts",
    title: tx("Check the plan and renewal date"),
    goal: "Open the billing or subscription page and tell me the current plan, its price and the next renewal date",
    url: "https://",
  },

  // Shopping & prices
  {
    id: "price-check",
    category: "shopping",
    title: tx("Look up a price"),
    goal: "Search the shop for {{product}}, open the best match and tell me its price, whether it is in stock and the delivery estimate",
    url: "https://",
    same: ["product"],
  },
  {
    id: "add-to-cart",
    category: "shopping",
    title: tx("Add to cart in a size and colour"),
    goal: "Search for {{product}}, open it, choose the size {{size}} and the colour {{color}}, add it to the cart, then open the cart and tell me the total. Do not check out",
    url: "https://",
    same: ["product"],
  },
  {
    id: "wishlist",
    category: "shopping",
    title: tx("Save to the wishlist"),
    goal: "Find {{product}} and add it to the wishlist, signing in with {{email}} and {{password}} if the site asks, then open the wishlist and confirm it is there",
    url: "https://",
    same: ["product"],
  },
  {
    id: "cheapest-three",
    category: "shopping",
    title: tx("Find the three cheapest"),
    goal: "Search for {{query}}, sort by price from low to high, filter to 4 stars and up, and tell me the name, price and link of the three cheapest results",
    url: "https://",
    same: ["query"],
  },
  {
    id: "coupon",
    category: "shopping",
    title: tx("Try a discount code"),
    goal: "Open the cart, enter {{coupon}} in the discount code field, apply it and tell me whether it was accepted and what the new total is. Do not check out",
    url: "https://",
  },
  {
    id: "order-status",
    category: "shopping",
    title: tx("Track an order"),
    goal: "Open the order history, find order {{order_number}} and tell me its status and the expected delivery date",
    url: "https://",
  },

  // Forms & sign-ups
  {
    id: "contact-form",
    category: "forms",
    title: tx("Fill a contact form"),
    goal: "Fill in the contact form with the name {{name}} and the message {{message}}, then send it",
    url: "https://",
  },
  {
    id: "booking",
    category: "forms",
    title: tx("Book an appointment"),
    goal: "Open the booking form, pick the service {{service}}, choose the first free time on {{date}} in the date picker, fill in {{full_name}} and {{email}}, then submit and tell me the confirmation number",
    url: "https://",
    same: ["service", "date"],
  },
  {
    id: "newsletter",
    category: "forms",
    title: tx("Sign up for a newsletter"),
    goal: "Find the newsletter sign-up, enter {{email}}, choose {{topic}} in the interests dropdown, tick only the required boxes and submit, then tell me what the page says",
    url: "https://",
    same: ["topic"],
  },
  {
    id: "address-autocomplete",
    category: "forms",
    title: tx("Enter an address with suggestions"),
    goal: "Open the address form, type {{street}} in the address field and pick the matching suggestion from the list, check that city and postcode were filled in, add the phone number {{phone}} and save",
    url: "https://",
  },
  {
    id: "survey-slider",
    category: "forms",
    title: tx("Answer a survey"),
    goal: "Answer the feedback survey: set the satisfaction slider to {{score}}, choose {{reason}} in the dropdown, write {{comment}} in the comments box, then submit and tell me what the thank-you page says",
    url: "https://",
  },
  {
    id: "quote-request",
    category: "forms",
    title: tx("Request a quote"),
    goal: "Fill in the quote request with the company {{company}}, {{seats}} seats, the start date {{date}} and the message {{message}}, then send it and tell me what the page says next",
    url: "https://",
  },

  // Reading & monitoring
  {
    id: "balance",
    category: "reading",
    title: tx("Read the balance"),
    goal: "Open the account page and tell me the current balance",
    url: "https://",
  },
  {
    id: "stock-size",
    category: "reading",
    title: tx("Check if a size is in stock"),
    goal: "On this product page, select the size {{size}} and tell me whether it is in stock; if it is not, tell me what the page says about when it is back",
    url: "https://",
    same: ["size"],
  },
  {
    id: "parcel",
    category: "reading",
    title: tx("Check a delivery"),
    goal: "Enter the tracking number {{tracking_number}} in the tracking form and tell me the latest status, where the parcel is now and the expected delivery date",
    url: "https://",
  },
  {
    id: "compare-plans",
    category: "reading",
    title: tx("Compare two plans"),
    goal: "Open the pricing page and compare the {{plan_a}} and {{plan_b}} plans: tell me the monthly price of each and three things one includes that the other does not",
    url: "https://",
    same: ["plan_a", "plan_b"],
  },
  {
    id: "status-page",
    category: "reading",
    title: tx("Check a status page"),
    goal: "Open the status page and tell me whether every service is working; if not, list the ones with a problem and since when",
    url: "https://",
  },
  {
    id: "newest-post",
    category: "reading",
    title: tx("Read the newest post"),
    goal: "Open the news or blog page and tell me the title and date of the newest post, and summarise it in two sentences",
    url: "https://",
  },

  // Social & messaging
  {
    id: "reply-newest",
    category: "social",
    title: tx("Reply to the newest message"),
    goal: "Open the messages, find the newest unread conversation and reply with {{reply}}. Send only that one reply, then tell me who it went to",
    url: "https://",
  },
  {
    id: "update-bio",
    category: "social",
    title: tx("Update the profile bio"),
    goal: "Open your profile, click Edit, replace the bio with {{bio}}, save, and check that the profile page shows the new text",
    url: "https://",
  },
  {
    id: "notifications",
    category: "social",
    title: tx("Catch up on notifications"),
    goal: "Open the notifications, tell me the five most recent ones in one line each, then mark them all as read",
    url: "https://",
  },

  // Admin & back-office
  {
    id: "row-menu",
    category: "admin",
    title: tx("Deactivate a user from the table"),
    goal: "In the users table, search for {{user_email}}, open that row's menu and choose Deactivate, accept the confirmation dialog, then tell me the row's new status",
    url: "https://",
    same: ["user_email"],
  },
  {
    id: "edit-record",
    category: "admin",
    title: tx("Update a customer record"),
    goal: "Open Customers, find {{customer}} with the search box, edit the record, set the status dropdown to {{status}} and the note to {{note}}, save, then tell me the updated date shown on the row",
    url: "https://",
  },
  {
    id: "count-pending",
    category: "admin",
    title: tx("Count pending orders"),
    goal: "Open Orders, filter to the status Pending, go through every page of results and tell me how many pending orders there are and the date of the oldest one",
    url: "https://",
  },
  {
    id: "export-report",
    category: "admin",
    title: tx("Export a report"),
    goal: "Open Reports, set the date range from {{from}} to {{to}}, choose CSV as the format and click Export, then tell me the name of the file it offers",
    url: "https://",
    same: ["from", "to"],
  },
  {
    id: "archive-closed",
    category: "admin",
    title: tx("Archive closed tickets"),
    goal: "Open the tickets list, filter to Closed, and archive every ticket closed before {{date}} using each row's menu, accepting each confirmation; page through all results, then tell me how many you archived",
    url: "https://",
    same: ["date"],
  },

  // Search & research
  {
    id: "wikipedia",
    category: "research",
    title: tx("Look something up on Wikipedia"),
    goal: "Search Wikipedia for {{topic}}, open the article and tell me in two sentences what it is about, plus the most important date in the infobox if there is one",
    url: "https://en.wikipedia.org",
    same: ["topic"],
  },
  {
    id: "opening-hours",
    category: "research",
    title: tx("Find opening hours"),
    goal: "Find the {{location}} branch with the site's search or store finder, open its page and tell me today's opening hours and the phone number",
    url: "https://",
    same: ["location"],
  },
  {
    id: "job-search",
    category: "research",
    title: tx("Find the newest job listings"),
    goal: "Search for jobs matching {{query}} in {{city}}, sort by newest, and tell me the title, company and posting date of the first five results",
    url: "https://",
    same: ["query", "city"],
  },
  {
    id: "docs-search",
    category: "research",
    title: tx("Find a page in the docs"),
    goal: "Use the documentation's search to find the page about {{topic}}, open it and tell me its title, its address and the first code example on it",
    url: "https://",
    same: ["topic"],
  },
];

/** The chips shown above an empty goal in Run a task: one per kind of task. "Log in" stays first. */
export const FEATURED_EXAMPLES: string[] = ["login-inbox", "balance", "contact-form", "price-check"];

export function exampleById(id: string): TaskExample | undefined {
  return TASK_EXAMPLES.find((e) => e.id === id);
}

/** An example's "same for every profile" slots, as dialog modes. */
export function sameForAll(ex: TaskExample | undefined): Record<string, Source> {
  return Object.fromEntries((ex?.same ?? []).map((s) => [s, "run" as const]));
}

/** The slot modes after picking an example: only the new goal's slots; a mode the user chose (or the saved
 *  task set) stays, the rest take the example's "same for all" presets. Modes of slots the new goal no
 *  longer has are dropped, so an earlier example's presets do not pile up. */
export function exampleModes(
  prev: Record<string, Source>,
  userSet: ReadonlySet<string>,
  ex: TaskExample,
): Record<string, Source> {
  const same = sameForAll(ex);
  const out: Record<string, Source> = {};
  for (const s of templateSlots(ex.goal)) {
    if (userSet.has(s) && prev[s]) out[s] = prev[s];
    else if (same[s]) out[s] = same[s];
  }
  return out;
}

/** The task name after picking an example: the example's title, unless the user typed a name of their own
 *  (anything but empty or the previous example's title). */
export function exampleTaskName(current: string, prevTitle: string | undefined, nextTitle: string): string {
  const c = current.trim();
  return !c || (prevTitle !== undefined && c === prevTitle.trim()) ? nextTitle : current;
}
