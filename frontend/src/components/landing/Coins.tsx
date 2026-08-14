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

function Coin({ kind, position, scale, speed, tilt = 0 }: { kind: CoinKind; position: [number, number, number]; scale: number; speed: number; tilt?: number }) {
  const group = useRef<Group>(null)
  const phase = useRef(0)
  const coin = COINS[kind]

  useFrame((_, delta) => {
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
          <cylinderGeometry args={[1, 1, .34, 128, 2, false]} />
          <meshPhysicalMaterial color={coin.mid} metalness={.7} roughness={.22} clearcoat={1} clearcoatRoughness={.08} />
        </mesh>

        <mesh position={[0, 0, .175]} castShadow>
          <circleGeometry args={[.91, 128]} />
          <meshPhysicalMaterial color={coin.face} metalness={.48} roughness={.2} clearcoat={1} clearcoatRoughness={.06} />
        </mesh>
        <mesh position={[0, 0, -.175]} rotation={[0, Math.PI, 0]}>
          <circleGeometry args={[.91, 128]} />
          <meshPhysicalMaterial color={coin.face} metalness={.48} roughness={.2} clearcoat={1} clearcoatRoughness={.06} />
        </mesh>

        <mesh position={[0, 0, .19]}>
          <torusGeometry args={[.79, .055, 32, 128]} />
          <meshPhysicalMaterial color={coin.edge} metalness={.75} roughness={.15} clearcoat={1} />
        </mesh>
        <mesh position={[0, 0, .196]}>
          <torusGeometry args={[.62, .012, 18, 128]} />
          <meshStandardMaterial color={coin.edge} metalness={.55} roughness={.25} />
        </mesh>

        <Text position={[0, 0, .225]} fontSize={kind === 'usdt0' ? .28 : .24} fontWeight={700} color={coin.ink} anchorX="center" anchorY="middle">
          {coin.label}
        </Text>
      </group>
    </Float>
  )
}

export function CoinCluster({ className = '' }: { className?: string }) {
  return (
    <div className={`pointer-events-none absolute inset-x-0 top-12 h-[26rem] ${className}`} aria-hidden="true">
      <Canvas camera={{ position: [0, .15, 7.7], fov: 36 }} dpr={[1, 1.8]} gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }} shadows>
        <ambientLight intensity={1.15} />
        <directionalLight position={[-4, 7, 7]} intensity={4.8} color="#ffffff" castShadow />
        <directionalLight position={[5, -1, 4]} intensity={2.4} color="#8cb7ff" />
        <pointLight position={[0, 3, 5]} intensity={24} color="#d8e8ff" />
        <Coin kind="fxrp" position={[-2.45, .18, .2]} scale={1.08} speed={.24} tilt={.18} />
        <Coin kind="usdt0" position={[.25, 1.05, -.45]} scale={.82} speed={.32} tilt={-.1} />
        <Coin kind="c2flr" position={[2.65, .3, .1]} scale={.94} speed={.28} tilt={.4} />
        <ContactShadows position={[0, -2.15, -1.2]} opacity={.18} scale={12} blur={3.2} far={5} color="#183a85" />
        <Environment preset="studio" />
      </Canvas>
    </div>
  )
}
