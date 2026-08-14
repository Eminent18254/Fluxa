import { Canvas, useFrame } from '@react-three/fiber'
import { ContactShadows, Environment, Float, Text } from '@react-three/drei'
import { useRef } from 'react'
import type { Group } from 'three'

type CoinKind = 'usdt0' | 'fxrp' | 'c2flr'

const COINS: Record<CoinKind, { label: string; face: string; mid: string; edge: string; ink: string }> = {
  usdt0: { label: 'USDT0', face: '#4f89f2', mid: '#2452e0', edge: '#c7dcff', ink: '#ffffff' },
  fxrp: { label: 'FXRP', face: '#dfeaff', mid: '#6b98f5', edge: '#ffffff', ink: '#17336e' },
  c2flr: { label: 'C2FLR', face: '#8b7cf4', mid: '#5a45e6', edge: '#d7d1ff', ink: '#ffffff' },
}

function Coin({ kind, position, scale, speed, tilt = 0, motionEnabled, compact }: { kind: CoinKind; position: [number, number, number]; scale: number; speed: number; tilt?: number; motionEnabled: boolean; compact: boolean }) {
  const group = useRef<Group>(null)
  const phase = useRef(0)
  const coin = COINS[kind]

  useFrame((_, delta) => {
    if (!motionEnabled) return
    phase.current += delta
    if (!group.current) return
    group.current.rotation.y = phase.current * speed + tilt
    group.current.rotation.x = Math.sin(phase.current * speed * .72) * .11 - .16
    group.current.rotation.z = Math.sin(phase.current * speed * .45) * .035
  })

  return (
    <Float speed={1.1 + speed} rotationIntensity={0.12} floatIntensity={.5}>
      <group ref={group} position={position} scale={scale}>
        <mesh rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[1, 1, .34, compact ? 64 : 96, 2, false]} />
          <meshPhysicalMaterial color={coin.mid} metalness={.7} roughness={.22} clearcoat={1} clearcoatRoughness={.08} />
        </mesh>

        <mesh position={[0, 0, .175]} castShadow>
          <circleGeometry args={[.91, compact ? 64 : 96]} />
          <meshPhysicalMaterial color={coin.face} metalness={.48} roughness={.2} clearcoat={1} clearcoatRoughness={.06} />
        </mesh>
        <mesh position={[0, 0, -.175]} rotation={[0, Math.PI, 0]}>
          <circleGeometry args={[.91, compact ? 64 : 96]} />
          <meshPhysicalMaterial color={coin.face} metalness={.48} roughness={.2} clearcoat={1} clearcoatRoughness={.06} />
        </mesh>

        <mesh position={[0, 0, .19]}>
          <torusGeometry args={[.79, .055, compact ? 16 : 24, compact ? 64 : 96]} />
          <meshPhysicalMaterial color={coin.edge} metalness={.75} roughness={.15} clearcoat={1} />
        </mesh>
        <mesh position={[0, 0, .196]}>
          <torusGeometry args={[.62, .012, compact ? 12 : 16, compact ? 64 : 96]} />
          <meshStandardMaterial color={coin.edge} metalness={.55} roughness={.25} />
        </mesh>

        <Text position={[0, 0, .225]} fontSize={kind === 'usdt0' ? .28 : .24} fontWeight={700} color={coin.ink} anchorX="center" anchorY="middle">
          {coin.label}
        </Text>
      </group>
    </Float>
  )
}

export function CoinCluster({ className = '', compact = false, motionEnabled = true }: { className?: string; compact?: boolean; motionEnabled?: boolean }) {
  return (
    <div className={`pointer-events-none absolute inset-x-0 top-6 h-[18rem] sm:top-12 sm:h-[26rem] ${className}`} aria-hidden="true">
      <Canvas frameloop={motionEnabled ? 'always' : 'demand'} camera={{ position: [0, .15, compact ? 8.6 : 7.7], fov: compact ? 40 : 36 }} dpr={compact ? [1, 1.2] : [1, 1.6]} gl={{ alpha: true, antialias: !compact, powerPreference: 'high-performance' }}>
        <ambientLight intensity={1.15} />
        <directionalLight position={[-4, 7, 7]} intensity={4.8} color="#ffffff" castShadow />
        <directionalLight position={[5, -1, 4]} intensity={2.4} color="#8cb7ff" />
        <pointLight position={[0, 3, 5]} intensity={24} color="#d8e8ff" />
        <Coin kind="fxrp" position={compact ? [-1.75, .05, .2] : [-2.45, .18, .2]} scale={compact ? .78 : 1.08} speed={.24} tilt={.18} motionEnabled={motionEnabled} compact={compact} />
        <Coin kind="usdt0" position={compact ? [.1, .82, -.45] : [.25, 1.05, -.45]} scale={compact ? .62 : .82} speed={.32} tilt={-.1} motionEnabled={motionEnabled} compact={compact} />
        <Coin kind="c2flr" position={compact ? [1.8, .05, .1] : [2.65, .3, .1]} scale={compact ? .7 : .94} speed={.28} tilt={.4} motionEnabled={motionEnabled} compact={compact} />
        {!compact && <ContactShadows position={[0, -2.15, -1.2]} opacity={.18} scale={12} blur={3.2} far={5} color="#183a85" />}
        {!compact && <Environment preset="studio" />}
      </Canvas>
    </div>
  )
}
