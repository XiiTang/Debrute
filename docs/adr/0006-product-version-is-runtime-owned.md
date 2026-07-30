# Product Version Is Runtime Owned

Debrute publishes Desktop, runtime, managed CLI, and official Skills as one
versioned product. Desktop carries a bootstrap seed, while Runtime materializes
the complete matching Runtime Product under the user product root and selects
one active version through the stable `current` path defined by
[ADR 0024](./0024-runtime-product-is-materialized-by-version.md). Runtime owns
discovery, and the title bar and General Settings invoke its same
whole-Product install capability. The managed CLI is replaced as part of that
Product but cannot initiate an update.
This was chosen over independently versioned or downloadable components so
installed surfaces cannot drift and release verification applies to one product
asset contract.
