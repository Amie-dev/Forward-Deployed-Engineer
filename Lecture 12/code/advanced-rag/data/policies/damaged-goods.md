---
docType: policy
category: damage
productIds: []
tenantId: northwind-eu
acl: [support, customer]
effectiveFrom: 2026-01-01
effectiveTo:
version: 2026.1
---
# Damaged and Faulty Goods Policy

## Reporting window

Damage or a fault that is visible at delivery must be reported within **48 hours** of the
delivery scan. Report it in the customer account under Orders → Report a problem, and
attach at least two photographs: one of the item and one of the shipping box, including
the label. Reports opened after 48 hours are still accepted, but they are handled as a
warranty claim rather than as a transit-damage claim, and the outcome depends on the
manufacturer's warranty terms.

## What counts as damaged

A product is damaged when it arrives physically broken, when it does not power on, when
a channel or driver is silent, or when the packaging shows impact damage consistent with
handling. Normal wear, cosmetic marks that do not affect function, and damage caused
after delivery are not covered by this policy.

## What the customer gets

A validated transit-damage claim is resolved with a replacement of the same model where
stock allows, or a full refund where it does not. No restocking fee is charged and return
shipping is paid by Northwind Audio. Replacement units ship with the same warranty term
as the original purchase.

## Relationship to the return window

A damage report does **not** extend the return window. If the item is also eligible for a
normal return, the return must still be started before that window closes; the damage
claim and the return are two separate processes and neither pauses the other. Support
should start both when a customer is inside both windows, because the damage claim is the
one that waives the restocking fee.

## Photographs and evidence

Two photographs are the minimum: one of the product showing the fault, and one of the
shipping box with the carrier label visible. A short video is requested instead of
photographs when the fault is intermittent, because a recording distinguishes a driver
that is silent from a pairing problem or a flat battery. Photographs are attached to
the order, not stored in the support inbox, so that a second agent does not have to ask
for them again.

## Concealed damage

Damage that is only discovered after the packaging has been opened is treated as
concealed damage. It follows the same 48-hour rule, counted from the delivery scan
rather than from the moment the parcel was opened, because the carrier's liability
window starts at delivery. Customers who report concealed damage after 48 hours are
handled under warranty, and support should explain that distinction rather than
promising a transit-damage replacement.

## Escalation

If a replacement is out of stock for more than ten business days, the case is escalated
to the category manager, who may authorise a refund without waiting for the replacement.
Escalations are recorded on the order so that the customer is not asked for the same
photographs twice.

## Escalation matrix

The escalation path depends on the value of the order and on how the damage was
discovered, because a claim that involves a carrier investigation has a different owner
than a claim that involves only the warehouse.

A claim under EUR 50 with photographs attached is resolved by the first-line agent
without approval. The agent issues a replacement from stock, or a refund where stock is
unavailable, and records the reason code `damage-minor` on the order. No escalation is
needed and the customer should not be transferred.

A claim between EUR 50 and EUR 200 requires a supervisor approval before the
replacement ships, because the unit is written off rather than returned to the vendor.
The supervisor checks the photographs against the carrier's scan record, and where the
scan shows no impact event the claim is reclassified as concealed damage and continues
under the same 48-hour rule.

A claim above EUR 200, or any claim where the carrier's scan record contradicts the
customer's description, is escalated to the claims desk the same business day. The
claims desk opens a carrier investigation, which takes up to ten business days, and
issues a provisional replacement when the customer's claims history is clean. The
provisional replacement is converted into a final replacement when the investigation
closes, or reversed when the investigation finds that the damage happened after
delivery.

Claims that involve a serial number mismatch, a missing warranty seal, or a delivery
address that differs from the billing address are escalated to the fraud desk instead,
and the customer is told that the claim is under review rather than that it has been
declined, because the review can take up to fifteen business days.

Escalations are recorded on the order with the agent's identifier, the reason code and
the timestamp, so that a later agent can see the full history without asking the
customer to repeat it.
