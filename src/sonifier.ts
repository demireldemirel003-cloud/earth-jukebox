import type { ColumnReading, ProfilePoint, SoundRole } from './gibs'

const PENTATONIC_SEMITONES = [0, 2, 4, 7, 9]
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

export interface SoundDescription {
  note: string
  frequency: number
}

export interface AudioLayerReading {
  role: SoundRole
  volume: number
  reading: ColumnReading
}

export function describeSound(latitude: number, octaveShift = 0): SoundDescription {
  const scalePosition = Math.round(((latitude + 85) / 170) * 14)
  const octave = Math.floor(scalePosition / PENTATONIC_SEMITONES.length)
  const semitone = PENTATONIC_SEMITONES[scalePosition % PENTATONIC_SEMITONES.length] + octave * 12
  const midiNote = 48 + semitone + octaveShift
  return {
    note: `${NOTE_NAMES[midiNote % 12]}${Math.floor(midiNote / 12) - 1}`,
    frequency: 440 * 2 ** ((midiNote - 69) / 12),
  }
}

export function formatReading(point: ProfilePoint, units: string): string {
  if (point.value === null) return 'No reading (land/ice)'
  const value = Number.isInteger(point.value) ? point.value.toFixed(0) : point.value.toFixed(1)
  return `${value} ${units}`
}

export class EarthSonifier {
  private context: AudioContext | undefined
  private mixBus: GainNode | undefined
  private analyser: AnalyserNode | undefined
  private peakBuffer: Float32Array<ArrayBuffer> | undefined

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext()
      const compressor = this.context.createDynamicsCompressor()
      compressor.threshold.value = -24
      compressor.knee.value = 12
      compressor.ratio.value = 20
      compressor.attack.value = 0.003
      compressor.release.value = 0.18
      const master = this.context.createGain()
      master.gain.value = 0.68
      this.mixBus = master
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 2048
      this.peakBuffer = new Float32Array(this.analyser.fftSize)
      master.connect(compressor)
      compressor.connect(this.analyser)
      this.analyser.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') await this.context.resume()
    if (this.context.state !== 'running') {
      throw new Error('Audio could not start. Check the browser sound permissions.')
    }
  }

  playColumn(layers: AudioLayerReading[]): void {
    if (!this.context || this.context.state !== 'running') return
    const startAt = this.context.currentTime + 0.004
    const activeCount = Math.max(1, layers.filter((layer) => layer.volume > 0).length)
    const mixScale = 1 / Math.sqrt(activeCount)

    for (const layer of layers) {
      if (layer.volume <= 0) continue
      const points = layer.reading.points.filter(
        (point): point is ProfilePoint & { value: number } => point.value !== null,
      )
      if (layer.role === 'ice') {
        points.filter((point) => Math.abs(point.latitude) >= 50).forEach((point, index) => {
          const concentration = clamp(point.value / 100, 0.04, 1)
          const frequency = describeSound(point.latitude, 24).frequency
          const amplitude = layer.volume * mixScale * (0.02 + concentration * 0.04)
          this.playTone(frequency, amplitude, startAt + index * 0.018, 0.13, 'sine')
          this.playTone(frequency * 2, amplitude * 0.22, startAt + index * 0.018, 0.19, 'sine')
        })
      } else if (layer.role === 'rain') {
        points.forEach((point, index) => {
          const intensity = Math.max(0, point.value)
          if (intensity < 0.02) return
          const noteCount = Math.min(4, 1 + Math.floor(intensity / 2))
          const strength = clamp(intensity / 12, 0.08, 1)
          for (let drop = 0; drop < noteCount; drop += 1) {
            this.playTone(
              describeSound(point.latitude, 12).frequency,
              layer.volume * mixScale * (0.012 + strength * 0.045),
              startAt + index * 0.018 + drop * 0.026,
              0.045,
              'sine',
            )
          }
        })
      } else if (layer.role === 'land') {
        points.forEach((point, index) => {
          const vegetation = clamp(point.value, 0, 1)
          this.playTone(
            describeSound(point.latitude, -12).frequency,
            layer.volume * mixScale * (0.02 + vegetation * 0.06),
            startAt + index * 0.018,
            0.15,
            'triangle',
          )
        })
      } else {
        points.forEach((point, index) => {
          const warmth = clamp(point.value / 30, 0, 1)
          this.playTone(
            describeSound(point.latitude).frequency,
            layer.volume * mixScale * (0.012 + warmth * 0.055),
            startAt + index * 0.018,
            0.23,
            'sine',
          )
        })
      }
    }
  }

  getPeak(): number {
    if (!this.analyser || !this.peakBuffer) return 0
    this.analyser.getFloatTimeDomainData(this.peakBuffer)
    let peak = 0
    for (const sample of this.peakBuffer) peak = Math.max(peak, Math.abs(sample))
    return peak
  }

  private playTone(
    frequency: number,
    amplitude: number,
    startAt: number,
    duration: number,
    type: OscillatorType,
  ): void {
    const context = this.context
    if (!context) return
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, startAt)
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.linearRampToValueAtTime(Math.max(0.0002, amplitude), startAt + Math.min(0.012, duration / 3))
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
    oscillator.connect(gain)
    gain.connect(this.mixBus ?? context.destination)
    oscillator.start(startAt)
    oscillator.stop(startAt + duration + 0.005)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
