// QRScannerView — iOS-only camera scanner for the pairing QR.
//
// AVCaptureSession + AVCaptureMetadataOutput(.qr) wrapped in a
// UIViewControllerRepresentable, with a dimmed mask + rounded aperture
// reticle (sized for the ghost-branded QR the Mac displays). The whole file
// is `#if os(iOS)` so the TaskWraithUI library still compile-checks on macOS
// via `swift build`; macOS callers simply don't get this symbol.
//
// Camera permission: requested on first appearance; a denial renders an
// in-place explainer instead of a black void. The capture session starts and
// stops off the main thread (startRunning blocks), and detections hop to the
// main actor before invoking `onCode` exactly once per presentation.

#if os(iOS)

import SwiftUI
@preconcurrency import AVFoundation
import UIKit

public struct QRScannerView: View {
    let onCode: (String) -> Void
    @State private var authorization: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(
        for: .video)

    public init(onCode: @escaping (String) -> Void) {
        self.onCode = onCode
    }

    public var body: some View {
        Group {
            switch authorization {
            case .authorized:
                CameraScanner(onCode: onCode)
                    .ignoresSafeArea()
                    .overlay(alignment: .bottom) {
                        Text("Point the camera at the QR on your Mac")
                            .font(.footnote)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(.ultraThinMaterial, in: Capsule())
                            .padding(.bottom, 32)
                    }
            case .notDetermined:
                ProgressView("Requesting camera access…")
                    .task {
                        let granted = await AVCaptureDevice.requestAccess(for: .video)
                        authorization = granted ? .authorized : .denied
                    }
            default:
                ContentUnavailableView(
                    "Camera access needed",
                    systemImage: "camera.fill",
                    description: Text(
                        "Allow camera access in Settings → TaskWraith to scan the pairing QR, or use the paste-the-code fallback."
                    ))
            }
        }
    }
}

private struct CameraScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.onCode = { code in
            // Fire once per presentation; the sheet dismisses on success.
            guard !context.coordinator.delivered else { return }
            context.coordinator.delivered = true
            onCode(code)
        }
        return controller
    }

    func updateUIViewController(_ controller: ScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var delivered = false
    }
}

// `@preconcurrency` conformance: the delegate protocol is nonisolated, but we
// pin the metadata callbacks to the MAIN queue (setMetadataObjectsDelegate
// queue: .main), so the main-actor-isolated delegate method is dynamically
// safe — this is the standard Swift 6 pattern for queue-pinned AVFoundation
// delegates on a UIKit (implicitly @MainActor) class.
final class ScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let sessionQueue = DispatchQueue(label: "tw.qr-scanner.session")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let device = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        previewLayer = preview

        addReticle()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
        layoutReticle()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        sessionQueue.async { [session] in
            if !session.isRunning { session.startRunning() }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard
            let qr = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject })
                .first(where: { $0.type == .qr }),
            let value = qr.stringValue, !value.isEmpty
        else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onCode?(value)
    }

    // ── Reticle: dimmed mask with a rounded square aperture ────────────────────

    private let maskLayer = CAShapeLayer()
    private let frameLayer = CAShapeLayer()

    private func addReticle() {
        maskLayer.fillRule = .evenOdd
        maskLayer.fillColor = UIColor.black.withAlphaComponent(0.45).cgColor
        view.layer.addSublayer(maskLayer)
        frameLayer.strokeColor = UIColor.white.withAlphaComponent(0.9).cgColor
        frameLayer.fillColor = UIColor.clear.cgColor
        frameLayer.lineWidth = 3
        view.layer.addSublayer(frameLayer)
    }

    private func layoutReticle() {
        let side = min(view.bounds.width, view.bounds.height) * 0.66
        let aperture = CGRect(
            x: (view.bounds.width - side) / 2,
            y: (view.bounds.height - side) / 2,
            width: side, height: side)
        let path = UIBezierPath(rect: view.bounds)
        let hole = UIBezierPath(roundedRect: aperture, cornerRadius: 18)
        path.append(hole)
        maskLayer.path = path.cgPath
        maskLayer.frame = view.bounds
        frameLayer.path = hole.cgPath
        frameLayer.frame = view.bounds
    }
}

#endif
