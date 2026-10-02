# Notes for Reviewers

## Building

**Environment:**

```
OS: Windows 11  
Node: 22.13.1  
npm: 10.9.2
```

**Build steps:**

```sh
# Install dependencies
npm i

# Build the production Firefox version of the extension to packages/jiten.reader-firefox.xpi
npm run pack firefox
```

## Personal parse-cache branch

This branch separates stable tokenization/definitions from mutable vocabulary state. Content persists in normalized IndexedDB with approximately 64 MiB LRU capacity, without fixed time expiry; state is account-scoped and refreshed through lightweight lookups after five minutes or relevant changes. Ttsu prioritizes visible paragraphs, applies small batches incrementally, and prefetches nearby mounted text during idle time. Run npm run test:parse-cache. See the root README and LONG-TEXT-VALIDATION.md for limits, validation scope and the upstream typecheck failures.
