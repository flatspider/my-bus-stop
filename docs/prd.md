# Product Requirements Document: Bus Stop App

**Working title:** Neat Bus  
**Last Update:** 2026-03-02  
**Authors:** Conor McManamon  
**Status:** Living Document

---

## 1. Product Objective

Provide a quick summary of the buses arriving at your bus stop.

## 2. Problem Statement

Transit apps (Apple Maps and Google Maps) use a data feed with ghost buses. The MTA website has accurate GPS data, but is difficult to navigate and hard to read. I want a clean, dynamically rendered, one page app that shows when the next bus is coming to my local bus stop.

The MTA designs their applications with scale and consistency in mind. They are focused on ROUTES, where they go, where they originate from, and where they end. As a bus rider, I care about my single bus stop. I need point to point transport. Additionally, the MTA builds around six digit bus stop codes. Those numbers are not listed in any other apps, which can make it difficult to use the number as a lookup function.

Google and Apple maps also build at scale. They use the universal GTFS-rt (a standard invented by Google in 2011) for every city they serve. The real solution to the data inconsistency is having the MTA deliver the GPS information properly to the GTFS-rt endpoints.

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
