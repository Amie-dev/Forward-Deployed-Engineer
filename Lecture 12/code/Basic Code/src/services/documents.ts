import type { Document } from "../models/types.js";

/**
 * Chapters 01–05 — the corpus.
 *
 * The lecture's running example: three policies that disagree about the same
 * question — "can I return my damaged headphones after 10 days?" — plus the
 * documents that make hybrid search, temporal filtering and access control
 * visible. Every document carries the metadata the notes require:
 *
 *   category       Chapter 05 — eligibility filter
 *   tenant + acl   Chapter 05 — the authorisation boundary
 *   effectiveFrom  Chapter 05 — the `asOf` temporal predicate
 *   supersededOn   Chapter 05 — so a superseded policy cannot win on similarity
 *
 * The `Document` contract itself lives in `models/types.ts` (Chapter 02); this
 * file is only the data.
 */

const northwind = "northwind";

export const DOCUMENTS: Document[] = [
  {
    id: "return-policy-general",
    title: "General Return Policy",
    category: "general",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2026-01-01",
    text: [
      "# General Return Policy",
      "## Scope",
      "This policy applies to every product we sell unless a category policy says otherwise.",
      "## Return window",
      "Customers may return an item within 30 days of delivery for a full refund.",
      "## Condition",
      "Returned items must be unused and in their original packaging.",
    ].join("\n"),
  },
  {
    id: "return-policy-electronics",
    title: "Electronics Return Policy",
    category: "electronics",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2026-03-01",
    text: [
      "# Electronics Return Policy",
      "## Scope",
      "This policy overrides the general return policy for all electronic products, including headphones and speakers.",
      "## Return window",
      "Electronic products can be returned within 7 days of delivery.",
      "## Fast charging",
      "Charging behaviour is described in the product datasheet, not in this policy.",
    ].join("\n"),
  },
  {
    // Superseded: for `asOf` before 2026-03-01 the 14-day rule is the live one.
    id: "return-policy-electronics-2025",
    title: "Electronics Return Policy (2025 edition)",
    category: "electronics",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2025-01-01",
    supersededOn: "2026-03-01",
    text: [
      "# Electronics Return Policy (2025 edition)",
      "## Return window",
      "Electronic products can be returned within 14 days of delivery.",
      "## Notes",
      "This edition was replaced on 1 March 2026 by the current 7-day policy.",
    ].join("\n"),
  },
  {
    id: "damaged-product-policy",
    title: "Damaged Product Reporting Policy",
    category: "damaged",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2026-01-01",
    text: [
      "# Damaged Product Reporting Policy",
      "## Reporting window",
      "Damage must be reported within 48 hours of delivery.",
      "## Exception",
      "Damage reported after 48 hours is treated as a normal return and follows the return policy for the product category.",
      "## Evidence",
      "A photograph of the damaged item is required for every damage claim.",
    ].join("\n"),
  },
  {
    id: "product-ax204",
    title: "AX-204 Wireless Headphone Datasheet",
    category: "product",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2026-02-01",
    text: [
      "# AX-204 Wireless Headphone Datasheet",
      "## Overview",
      "The AX-204 is an over-ear wireless headphone with active noise cancelling.",
      "## Charging",
      "The AX-204 supports fast charging: a 10 minute charge gives 6 hours of playback.",
      "## Warranty",
      "The AX-204 carries a 24 month limited warranty.",
    ].join("\n"),
  },
  {
    // Deliberately similar wording: the document dense search prefers by mistake.
    id: "product-bx900",
    title: "BX-900 Wireless Headphone Datasheet",
    category: "product",
    tenant: northwind,
    acl: ["support", "customer"],
    effectiveFrom: "2026-02-01",
    text: [
      "# BX-900 Wireless Headphone Datasheet",
      "## Overview",
      "The BX-900 is a wireless headphone with active noise cancelling and a fast charging case.",
      "## Charging",
      "The BX-900 charging case supports fast charging for the earbuds only.",
      "## Warranty",
      "The BX-900 carries a 12 month limited warranty.",
    ].join("\n"),
  },
  {
    // Wrong ACL: proves the filter is an authorisation boundary, not a relevance
    // feature. Same tenant as the customer, but not readable by support.
    id: "refund-sop-internal",
    title: "Refund Processing SOP",
    category: "internal",
    tenant: northwind,
    acl: ["finance"],
    effectiveFrom: "2026-01-01",
    text: [
      "# Refund Processing SOP",
      "## Steps",
      "Finance approves refunds above 500 euros before the support agent issues them.",
      "## Timeline",
      "Refunds are settled within 5 business days.",
    ].join("\n"),
  },
];
