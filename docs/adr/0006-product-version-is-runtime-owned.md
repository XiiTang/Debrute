# Product Version Is Runtime Owned

Debrute publishes Desktop, runtime, managed CLI, and official Skills as one
versioned product. Desktop carries a bootstrap seed, while Runtime materializes
the complete matching Runtime Product under the user product root and selects
one active version through the stable `current` path defined by
[ADR 0024](./0024-runtime-product-is-materialized-by-version.md). Settings and
`debrute update` invoke the same Runtime-owned whole-product update capability.
This was chosen over independently versioned or downloadable components so
installed surfaces cannot drift and release verification applies to one product
asset contract.
