# Remote Media Fetches Bind Validated DNS

Debrute validates every address returned for a public remote media host and
binds one validated address to the actual HTTP(S) socket while preserving the
original hostname for HTTP and TLS semantics. Redirect targets repeat the same
policy. This was chosen over validating a URL and then passing it to generic
`fetch`, because a second independent resolution would reopen DNS rebinding and
private-network access after policy approval.
