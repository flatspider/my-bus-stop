# Product Requirements Document: Bus Stop App

**Working title:** Neat Bus
**Last Update:** 2026-03-02
**Authors:** Conor McManamon
**Status:** Living Document

---

## 1. Product Objective

Provide a quick and easy summary of the buses arriving at your bus stop.

## 2. Problem Statement

Transit apps (Apple Maps and Google Maps) provide inconsistent bus information that has caused me to miss the bus. The MTA website has better data, but is difficult to navigate and hard to read. I want a clean, dynamically rendered, one page app that shows when the next bus is coming to my local bus stop.

The MTA designs all of their applications with scale in mind. They are focused on the ROUTES, where they go, where they originate from, and where they end. As a bus rider, I care about my single bus stop. The routes are mostly irrelevant to me. I need point to point transport. The MTA designs from the top down, but to provide more value they should design from the bottom up. Additionally, the MTA builds around bus stop codes. Those six digit numbers are not listed in any other apps, which can make it difficult to use the number as a lookup function.

Google and Apple maps are truly building at scale. They use the GTFS-rt (a standard invented by Google in 2011) that is used in every city in the world. The real solution to this is having the MTA ensure that they are providing consistent information on the GTFS-rt.

## 3. Scope

- A single user browser-based dashboard
- Clean visual design. Strong visual hierarchy directing user immediately to relevant bus
- Ability to enter bus stop code to customize bus stop
- Settings panel to tweak display per user

## 4. Target Audience & User Stories

**Primary audience:** Me. I open this app every day.

**Secondary audience:** Additional users who also want a clean interface.

### 4a. User Stories

- **As a user,** I want to see how long I have to get to the bus stop.
- **As a user,** I want to know if the bus after the initial one is close.
- **As a user,** I want to know how out of date the information on the page is.

### 4b. User Journey

1. Player lands on the page.
2. Glances at top card.
3. The user reads the distance of the bus in estimated minutes.
4. The user catches their bus.

## 5. Vision — Look and Feel

Strong visual hierarchy.

## 6. Success Metrics

1. Quick to read bus info.
2. User has information to catch their bus.
3. Do users upload their own songs...?
4. Do they rate the auto-generated songs as fun?

## 7. Milestones

- [ ] Have functioning data cards with relevant bus info
- [ ] Improve design with clear visual hierarchy
- [ ] Alert user to stale data
- [ ] Clickable cards that take you to MTA bus route
- [ ] Allow for customized settings to set. Store in cookies.
- [ ] Shareable QR code
- [ ] Auto load based on location. Ask downtown or uptown.

## 8. Tradeoffs & Open Questions

**Data Source** Each bus is connected by CleverCAD GPS devices. These three separate data sources. The GTFS-RT feed (failure mode backs up to the schedule) occasionally provides inaccurate info. There is SIRI API, and then this app is using the OneBusAway API.

## Learning Lessons

- Building at scale has tradeoffs.

---

_This document is a living artifact. Update it as decisions are made and assumptions are tested._
