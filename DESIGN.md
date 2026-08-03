---
version: beta
name: Ray Central Command
description: A calm, high-signal operations console for a modern real-estate team.
colors:
  ink: "#101828"
  ink-soft: "#344054"
  canvas: "#F4F6F8"
  surface: "#FFFFFF"
  surface-subtle: "#F8FAFC"
  border: "#E4E7EC"
  primary: "#175CD3"
  primary-hover: "#1849A9"
  accent: "#7F56D9"
  success: "#067647"
  warning: "#B54708"
  danger: "#B42318"
typography:
  display:
    fontFamily: Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: -0.03em
  heading:
    fontFamily: Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: -0.02em
  body:
    fontFamily: Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif
    fontSize: 12px
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: 0.01em
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  page: 36px
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  full: 9999px
components:
  sidebar:
    background: "{colors.ink}"
    foreground: "#D0D5DD"
    activeBackground: "#FFFFFF14"
  card:
    background: "{colors.surface}"
    border: "{colors.border}"
    radius: "{rounded.lg}"
  button-primary:
    background: "{colors.primary}"
    foreground: "#FFFFFF"
    radius: "{rounded.sm}"
  command-hero:
    background: "linear-gradient(135deg, #101828 0%, #162B52 62%, #312E6F 100%)"
    foreground: "#FFFFFF"
    radius: 20px
  metric-card:
    background: "{colors.surface}"
    border: "{colors.border}"
    radius: "{rounded.lg}"
---

# Ray Central Command

## Overview

The dashboard should feel like an expert operations room: calm, decisive, information-dense without feeling crowded, and trustworthy enough for sensitive client work. The shell is inspired by mature open-source admin patterns—persistent grouped navigation, a contextual header, contained tables, clear status chips, and responsive behavior—while remaining a lightweight server-rendered application.

## Colors

Midnight ink creates a focused navigation rail. A cool limestone canvas separates the working area from white operational surfaces. Blue is reserved for navigation and primary actions; green, amber, and red communicate system state. Status color must never be the only signal: every status also includes text.

## Typography

Use the system-first Inter stack so the interface is fast and dependable without a font CDN. Headings use compact negative tracking. Metadata is smaller but remains at least 12px with strong contrast.

## Layout

Desktop uses a 248px persistent sidebar and a flexible content column capped at 1600px. The header remains visible while scrolling. Related operations belong in cards or bordered table surfaces. Mobile collapses the sidebar into a keyboard-accessible drawer and preserves horizontal table scrolling.

The first authenticated viewport is **Today**, not a generic lead table. It contains a date-aware command hero, an operations pulse, four live metrics, an attention queue, and a pipeline snapshot. The user should understand the state of the business before scrolling.

## Elevation & Depth

Use tonal layers and one-pixel borders for most hierarchy. Shadows are subtle and reserved for the sidebar, floating mobile navigation, and hovered cards.

## Shapes

Cards use 16px corners; controls and compact surfaces use 8–12px corners; state chips are fully rounded. Avoid decorative rounding that obscures dense data.

## Components

Navigation items have clear active, hover, and focus-visible states. Tables always have a contained surface, sticky-looking header treatment, and comfortable row height. Forms use consistent labels, 40px minimum controls, visible focus rings, and explicit primary/destructive actions. Empty states explain what creates the first record.

### Command hero

The hero establishes context rather than advertising the product. It shows the Toronto operating date, a short greeting, what Central Command is responsible for, and a compact systems pulse. Decorative depth uses CSS gradients and concentric borders; it never competes with operational information.

### Metrics

The top metric row uses exactly four cards on desktop: active lead records, decisions waiting, upcoming showings, and active listings. Each metric includes a label, real value, small semantic icon, and clarifying footnote. Zero is displayed honestly and never replaced by sample data.

### Attention queue

Attention is exception-based. Items appear only when an actionable threshold is crossed: approvals waiting, follow-ups due, new leads untriaged after 48 hours, or automation failures in the last 24 hours. Each item links directly to the work surface that resolves it.

### Pipeline snapshot

Bars compare active records using the largest current stage as the visual denominator. Stage text and counts remain visible so length and color are not the only signals. Until the engagement migration is complete, the component is explicitly labeled as the legacy lead-stage view.

### Operating lanes

Buyer, seller, pre-con, and recruiting are always visible as the business's four operating lanes. A lane with no implemented ledger must show a dash and its real build state; it must never fabricate pipeline counts.

### Responsive rules

- Above 1100px: four metrics and four operating lanes per row; attention and pipeline share a row.
- Between 620px and 1100px: metrics and lanes use two columns; attention and pipeline stack.
- Below 620px: every high-signal component becomes one column, the hero pulse fills the width, navigation becomes a drawer, and tables scroll horizontally.

## Do's and Don'ts

- Keep every operational tab inside the same shell and use the Systems page only for external specialist consoles.
- Show live connection state and the next useful action.
- Preserve review gates for messages, offers, and outbound calling.
- Never expose API credentials, lockbox instructions, or private MLS fields in status pages.
- Never describe automation as self-learning when it cannot be reviewed, disabled, or traced to explicit feedback.
