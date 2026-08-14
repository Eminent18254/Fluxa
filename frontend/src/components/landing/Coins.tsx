import { Canvas, useFrame } from '@react-three/fiber'
import { ContactShadows, Environment, Float, Text } from '@react-three/drei'
import { useRef } from 'react'
import type { Group } from 'three'

type CoinKind = 'usd' | 'usdt' | 'fxrp' | 'flr'

const COINS: Record<CoinKind, { label: string; face: string; mid: string; edge: string; ink: string }> = {
  usd: { label: '$', face: '#4d7ff1', mid: '#2452e0', edge: '#a9c8ff', ink: '#ffffff' },
  usdt: { label: 'T', face: '#27c99a', mid: '#0f9b76', edge: '#9ff4d9', ink: '#ffffff' },
  fxrp: { label: 'FXRP', face: '#dfeaff', mid: '#6b98f5', edge: '#ffffff', ink: '#17336e' },
  flr: { label: 'FLR', face: '#ff5d89', mid: '#d91f55', edge: '#ffc0d2', ink: '#ffffff' },
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

        <Text position={[0, 0, .225]} fontSize={kind === 'usd' || kind === 'usdt' ? .68 : kind === 'fxrp' ? .22 : .25} fontWeight={700} color={coin.ink} anchorX="center" anchorY="middle">
          {coin.label}
        </Text>
        {kind === 'usdt' && <mesh position={[0, -.02, .227]}><boxGeometry args={[.68, .055, .025]} /><meshBasicMaterial color="#ffffff" /></mesh>}
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
        <Coin kind="usd" position={[-4.05, -.35, -.9]} scale={.74} speed={.34} tilt={-.45} />
        <Coin kind="fxrp" position={[-1.55, .48, .35]} scale={1.08} speed={.24} tilt={.18} />
        <Coin kind="usdt" position={[.58, 1.42, -.45]} scale={.7} speed={.38} tilt={-.1} />
        <Coin kind="flr" position={[2.9, .38, .1]} scale={.94} speed={.28} tilt={.4} />
        <ContactShadows position={[0, -2.15, -1.2]} opacity={.18} scale={12} blur={3.2} far={5} color="#183a85" />
        <Environment preset="studio" />
      </Canvas>
    </div>
  )
}
