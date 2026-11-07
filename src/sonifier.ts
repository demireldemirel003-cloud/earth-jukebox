import type { ColumnReading, ProfilePoint, SoundRole } from './gibs'

const PENTATONIC_SEMITONES = [0, 2, 4, 7, 9]
const POLES_SEMITONES = [0, 1, 5, 7, 10]
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

type SceneSound = 'ocean' | 'humans' | 'poles' | 'land' | 'air'

interface ScenePalette {
  scale: number[]
  transpose: number
  cutoff: number
  reverb: number
  delay: number
}

const SCENE_PALETTES: Record<SceneSound, ScenePalette> = {
  ocean: { scale: PENTATONIC_SEMITONES, transpose: 0, cutoff: 3800, reverb: 0.2, delay: 0.07 },
  humans: { scale: PENTATONIC_SEMITONES, transpose: 12, cutoff: 6400, reverb: 0.1, delay: 0.035 },
  poles: { scale: POLES_SEMITONES, transpose: 12, cutoff: 3100, reverb: 0.38, delay: 0.16 },
  land: { scale: PENTATONIC_SEMITONES, transpose: -5, cutoff: 4200, reverb: 0.16, delay: 0.06 },
  air: { scale: POLES_SEMITONES, transpose: 5, cutoff: 5000, reverb: 0.28, delay: 0.12 },
}

export interface SoundDescription {
  note: string
  frequency: number
}

export interface AudioLayerReading {
  role: SoundRole
  volume: number
  reading: ColumnReading
  longitude: number
  minValue: number
  maxValue: number
}

interface Voice {
  oscillator: OscillatorNode
  filter: BiquadFilterNode
  gain: GainNode
  panner: StereoPannerNode
}

export function describeSound(
  latitude: number,
  octaveShift = 0,
  valueStep = 0,
  scene = 'ocean',
): SoundDescription {
  const palette = SCENE_PALETTES[scene as SceneSound] ?? SCENE_PALETTES.ocean
  return describeSoundInScale(latitude, octaveShift, palette.scale, palette.transpose, valueStep)
}

function describeSoundInScale(
  latitude: number,
  octaveShift: number,
  scale: number[],
  transpose: number,
  valueStep = 0,
): SoundDescription {
  const scalePosition = Math.max(0, Math.round(((latitude + 85) / 170) * 14) + valueStep)
  const octave = Math.floor(scalePosition / scale.length)
  const semitone = scale[scalePosition % scale.length] + octave * 12
  const midiNote = 48 + semitone + octaveShift + transpose
  return {
    note: `${NOTE_NAMES[((midiNote % 12) + 12) % 12]}${Math.floor(midiNote / 12) - 1}`,
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
  private reverbSend: GainNode | undefined
  private delaySend: GainNode | undefined
  private voices = new Map<string, Voice>()
  private pitchSteps = new Map<string, number>()
  private scene: SceneSound = 'ocean'

  async unlock(): Promise<void> {
    if (!this.context) this.createAudioGraph()
    if (this.context?.state === 'suspended') await this.context.resume()
    if (this.context?.state !== 'running') {
      throw new Error('Audio could not start. Check the browser sound permissions.')
    }
  }

  setScene(scene: string): void {
    const palette = SCENE_PALETTES[scene as SceneSound] ?? SCENE_PALETTES.ocean
    this.scene = scene in SCENE_PALETTES ? (scene as SceneSound) : 'ocean'
    if (!this.context) return
    const now = this.context.currentTime
    this.reverbSend?.gain.setTargetAtTime(palette.reverb, now, 0.2)
    this.delaySend?.gain.setTargetAtTime(palette.delay, now, 0.2)
    for (const voice of this.voices.values()) {
      voice.filter.frequency.setTargetAtTime(this.voiceCutoff(voice.oscillator.type, palette.cutoff), now, 0.15)
    }
  }

  getPitchStep(role: SoundRole, latitude: number, normalizedValue: number): number {
    const key = `${role}:${latitude}`
    const step = this.pitchStepWithHysteresis(normalizedValue, this.pitchSteps.get(key) ?? 0)
    this.pitchSteps.set(key, step)
    return step
  }

  playColumn(layers: AudioLayerReading[]): void {
    const context = this.context
    if (!context || context.state !== 'running') return
    const now = context.currentTime + 0.012
    const palette = SCENE_PALETTES[this.scene]
    const activeCount = Math.max(
      1,
      layers.filter((layer) => layer.volume > 0 && layer.reading.points.some((point) => point.value !== null)).length,
    )
    const mixScale = 1 / Math.sqrt(activeCount)

    for (const voice of this.voices.values()) {
      voice.gain.gain.cancelScheduledValues(now)
      voice.gain.gain.setTargetAtTime(0, now, 0.08)
    }

    for (const layer of layers) {
      if (layer.volume <= 0) continue
      const points = layer.reading.points.filter(
        (point): point is ProfilePoint & { value: number } => point.value !== null,
      )
      for (const point of points) {
        const key = `${layer.role}:${point.latitude}`
        const voice = this.getVoice(key, layer.role, now)
        const valueRange = layer.maxValue - layer.minValue
        const normalized = valueRange > 0 ? clamp((point.value - layer.minValue) / valueRange, 0, 1) : 0.5
        const pitchStep = this.getPitchStep(layer.role, point.latitude, normalized)
        const frequency = describeSoundInScale(
          point.latitude,
          this.roleOctave(layer.role),
          palette.scale,
          palette.transpose,
          pitchStep,
        ).frequency
        const amplitude = this.roleAmplitude(layer.role, point.value) * layer.volume * mixScale
        voice.oscillator.frequency.setTargetAtTime(frequency, now, 0.065)
        voice.gain.gain.cancelScheduledValues(now)
        voice.gain.gain.setTargetAtTime(amplitude, now, 0.085)
        voice.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, layer.longitude / 180)), now, 0.14)
      }
    }
  }

  release(): void {
    if (!this.context) return
    const now = this.context.currentTime
    for (const voice of this.voices.values()) {
      voice.gain.gain.cancelScheduledValues(now)
      voice.gain.gain.setTargetAtTime(0, now, 0.12)
      voice.oscillator.stop(now + 1)
    }
    this.voices.clear()
  }

  getPeak(): number {
    if (!this.analyser || !this.peakBuffer) return 0
    this.analyser.getFloatTimeDomainData(this.peakBuffer)
    let peak = 0
    for (const sample of this.peakBuffer) peak = Math.max(peak, Math.abs(sample))
    return peak
  }

  private createAudioGraph(): void {
    const context = new AudioContext()
    const input = context.createGain()
    input.gain.value = 0.72
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -20
    compressor.knee.value = 18
    compressor.ratio.value = 12
    compressor.attack.value = 0.025
    compressor.release.value = 0.32
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    const peakBuffer = new Float32Array(analyser.fftSize)

    const dryGain = context.createGain()
    dryGain.gain.value = 0.82
    input.connect(dryGain)
    dryGain.connect(compressor)

    const convolver = context.createConvolver()
    convolver.buffer = this.createImpulseResponse(context)
    const reverbSend = context.createGain()
    const reverbReturn = context.createGain()
    reverbReturn.gain.value = 0.22
    input.connect(reverbSend)
    reverbSend.connect(convolver)
    convolver.connect(reverbReturn)
    reverbReturn.connect(compressor)

    const delay = context.createDelay(0.6)
    delay.delayTime.value = 0.24
    const delaySend = context.createGain()
    const feedback = context.createGain()
    feedback.gain.value = 0.16
    input.connect(delaySend)
    delaySend.connect(delay)
    delay.connect(feedback)
    feedback.connect(delay)
    delay.connect(compressor)

    compressor.connect(analyser)
    analyser.connect(context.destination)
    this.context = context
    this.mixBus = input
    this.analyser = analyser
    this.peakBuffer = peakBuffer
    this.reverbSend = reverbSend
    this.delaySend = delaySend
    this.setScene(this.scene)
  }

  private createImpulseResponse(context: AudioContext): AudioBuffer {
    const duration = 1.8
    const impulse = context.createBuffer(2, Math.floor(context.sampleRate * duration), context.sampleRate)
    let seed = 19373
    for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
      const samples = impulse.getChannelData(channel)
      for (let index = 0; index < samples.length; index += 1) {
        seed = (seed * 16807) % 2147483647
        const noise = (seed / 2147483647) * 2 - 1
        const decay = (1 - index / samples.length) ** 2.8
        samples[index] = noise * decay * 0.28
      }
    }
    return impulse
  }

  private getVoice(key: string, role: SoundRole, now: number): Voice {
    const existing = this.voices.get(key)
    if (existing) return existing
    const context = this.context!
    const oscillator = context.createOscillator()
    const filter = context.createBiquadFilter()
    const gain = context.createGain()
    const panner = context.createStereoPanner()
    oscillator.type = this.waveform(role)
    oscillator.frequency.value = 220
    filter.type = 'lowpass'
    filter.frequency.value = this.voiceCutoff(oscillator.type, SCENE_PALETTES[this.scene].cutoff)
    filter.Q.value = 0.55
    gain.gain.value = 0
    oscillator.connect(filter)
    filter.connect(gain)
    gain.connect(panner)
    panner.connect(this.mixBus!)
    oscillator.start(now)
    const voice = { oscillator, filter, gain, panner }
    this.voices.set(key, voice)
    return voice
  }

  private waveform(role: SoundRole): OscillatorType {
    if (role === 'land' || role === 'cloud' || role === 'ocean-life') return 'triangle'
    return 'sine'
  }

  private voiceCutoff(waveform: OscillatorType, sceneCutoff: number): number {
    return waveform === 'triangle' ? Math.min(sceneCutoff, 2600) : sceneCutoff
  }

  private roleOctave(role: SoundRole): number {
    if (role === 'ice' || role === 'night-lights') return 12
    if (role === 'land') return -7
    if (role === 'rain' || role === 'water-vapor') return 5
    if (role === 'ocean-life') return -5
    return 0
  }

  private roleAmplitude(role: SoundRole, value: number): number {
    if (role === 'ice') return 0.035 + clamp(value / 100, 0, 1) * 0.035
    if (role === 'rain') return 0.012 + clamp(Math.max(0, value) / 12, 0, 1) * 0.04
    if (role === 'land') return 0.018 + clamp(value, 0, 1) * 0.035
    if (role === 'ocean-life') return 0.012 + clamp((Math.log10(Math.max(value, 0.001)) + 3) / 4.3, 0, 1) * 0.026
    if (role === 'water-vapor') return 0.011 + clamp(value / 8, 0, 1) * 0.025
    if (role === 'cloud') return 0.01 + clamp(value / 100, 0, 1) * 0.024
    if (role === 'night-lights') return 0.01 + clamp((Math.log10(Math.max(value, 0.01)) + 2) / 5, 0, 1) * 0.035
    return 0.015 + clamp(value / 30, 0, 1) * 0.04
  }

  private pitchStepWithHysteresis(normalizedValue: number, previousStep: number): number {
    let step = previousStep
    while (step < 2 && normalizedValue > (step + 1) / 3 + 0.055) step += 1
    while (step > 0 && normalizedValue < step / 3 - 0.055) step -= 1
    return step
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
