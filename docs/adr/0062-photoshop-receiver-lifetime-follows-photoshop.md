# Photoshop Receiver Lifetime Follows Photoshop

The UXP plugin uses Photoshop's startup load event and retains its live receiver
when the plugin panel is closed; panel visibility controls presentation, not
the Photoshop session. While disconnected it runs one non-overlapping probe of
the closed Photoshop gateway port pool every five seconds, stopping immediately
after a session becomes ready and resuming after session loss. An announced
Runtime replacement may begin the next round immediately; the panel does not
expose a manual reconnect action. This makes discovery independent of whether
Runtime or Photoshop
starts first without adopting offline delivery: each reconnection creates a
fresh ephemeral session, and queued, in-flight, or failed transfers are never
restored or replayed. The retry loop discovers only the Runtime gateway;
Photoshop Documents remain event-driven rather than polled.
