import AVFoundation
import CoreMotion

public struct BatVuAudioFrame: Sendable {
    public let sampleRate: Double
    public let hostTime: UInt64
    public let samples: [Float]
    public let attitude: CMQuaternion?
}

public final class BatVuAudioCapture {
    private let engine = AVAudioEngine()
    private let motion = CMMotionManager()
    private let session = AVAudioSession.sharedInstance()

    public init() {}

    public func configure(preferredSampleRate: Double = 48_000,
                          preferredBufferDuration: TimeInterval = 0.005) throws -> Double {
        try session.setCategory(.playAndRecord, options: [.defaultToSpeaker])
        try session.setPreferredSampleRate(preferredSampleRate)
        try session.setPreferredIOBufferDuration(preferredBufferDuration)
        try session.setActive(true)

        let actualSampleRate = session.sampleRate
        guard actualSampleRate > 0 else { throw BatVuAudioError.invalidSampleRate }
        return actualSampleRate
    }

    public func start(onFrame: @escaping @Sendable (BatVuAudioFrame) -> Void) throws {
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw BatVuAudioError.invalidSampleRate }

        if motion.isDeviceMotionAvailable {
            motion.deviceMotionUpdateInterval = 1.0 / 100.0
            motion.startDeviceMotionUpdates()
        }

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, when in
            guard let self,
                  let channel = buffer.floatChannelData?[0] else { return }
            let count = Int(buffer.frameLength)
            let samples = Array(UnsafeBufferPointer(start: channel, count: count))
            let attitude = self.motion.deviceMotion?.attitude.quaternion
            onFrame(BatVuAudioFrame(
                sampleRate: format.sampleRate,
                hostTime: when.hostTime,
                samples: samples,
                attitude: attitude
            ))
        }

        engine.prepare()
        try engine.start()
    }

    public func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        motion.stopDeviceMotionUpdates()
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }
}

public enum BatVuAudioError: Error {
    case invalidSampleRate
}
