# How to: Devices tab

**Platform:** Electron

## What it is
The Devices tab is where you pair iPhones and iPads with this Mac, manage paired devices and the workspaces they can reach, and configure how the bridge daemon is found over the network (Bonjour and Tailscale).

## Where to find it
**Settings → Integrations → Devices**.

<!-- TODO(screenshot): Devices tab showing QR code, paired devices list, and networking options -->

## How to use it
1. Set a **Device label** (e.g. "iPad") and scan the QR code from TaskWraith on your iPhone or iPad, or use **Copy setup payload** to paste the manual setup JSON instead.
2. Click the QR to maximise it on screen if the camera has trouble scanning, then verify the 6-digit code shown on both screens before confirming the pair.
3. Review **Paired devices** to see connection status, and click **Remove** on any device to revoke its access (it must scan the QR again to reconnect).
4. Under **Paired-device workspace access**, add the workspaces a paired device is allowed to run agents against — an empty list denies all iOS-initiated runs, and every remote action still goes through desktop policy and approval gates.
5. Use **Tailscale · remote access** to reach this Mac from outside your local network without port-forwarding.
6. Check **Bridge networking** to see how the daemon advertises itself to paired devices on the local network.

## Tips & related
- [Devices popover](../footer-control-row/devices-popover.md) — quick status view in the sidebar footer with a link back to this tab.
- [iOS ensemble UI](../ensemble-mode/ios-ensemble-ui.md) — using TaskWraith on your paired iPhone or iPad.
