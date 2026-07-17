# Development Constitution

## Purpose

This document governs how Jarvis OS is built, extended, and maintained by engineers and coding agents.

It is distinct from the Jarvis Constitution, which defines Jarvis’ identity and behavior.

This document defines architectural principles, workflow discipline, and decision-making priorities.

## Core Principle

Every implementation must strengthen the architecture, not merely increase functionality.

## Foundation Before Features

Prefer reusable systems over one-off implementations.

Examples:

- ❌ Build Voice Recognition → ✅ Build a Perception Framework that can later support voice, vision, sensors, or other inputs.
- ❌ Build GitHub Support → ✅ Build a Capability Framework that GitHub becomes one capability within.
- ❌ Build a Docker Module → ✅ Build a Resource Execution Framework capable of supporting Docker and future execution environments.

Build the framework first. The feature then becomes trivial.

## Minimal Viable Architecture

Build components only when:

1. A real requirement exists.
2. The current architecture cannot support the requirement elegantly.
3. The new component improves future extensibility.

Avoid speculative engineering.

## Evolution Over Expansion

Every subsystem must be:

- Replaceable
- Isolated
- Interface-driven

Growth should feel additive, never destructive.

## Simplicity Wins

Choose the simplest architecture that can naturally evolve. Avoid adding complexity simply because it is technically possible.

Simple systems survive. Complicated systems collapse.

## Architectural Integrity

Never bypass existing systems for convenience. If a feature requires breaking the architecture, improve the architecture first.

Every new capability must integrate through existing interfaces.

No shortcuts. No special cases.

## Event‑Driven Thinking

Components should communicate through well-defined events rather than direct dependencies. Loose coupling is preferred over convenience.

## Stable Interfaces

Favor stable contracts over implementation details. Interfaces should remain stable even if the underlying technology changes completely.

Jarvis should be able to replace LLMs, memory providers, databases, execution engines, and UI frameworks without changing its identity.

## Refactoring

If existing code conflicts with the architectural direction, prefer refactoring over layering new complexity.

Technical debt compounds. Architectural clarity compounds.

## Long‑Term Responsibility

Assume this project will exist for many years. Write code that future engineers—and future AI coding models—can understand without historical context.

Optimize for maintainability, replaceability, and architectural clarity over implementation speed.

## Decision Rule

Whenever uncertainty exists, ask:

> *"What implementation leaves Jarvis in a stronger architectural position after this feature is complete?"*

Choose that solution.
