import { expect } from 'chai'
import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'

describe('Fluxa V2 multi-asset invoices', () => {
  async function fixture() {
    const [owner, merchant, customer] = await ethers.getSigners()
    const Token = await ethers.getContractFactory('MockERC20')
    const fxrp = await Token.deploy('FXRP', 'FXRP', 6)
    const usdt = await Token.deploy('USDT0', 'USDT0', 6)
    const Oracle = await ethers.getContractFactory('MockPriceOracle')
    const oracle = await Oracle.deploy()
    const Invoice = await ethers.getContractFactory('FluxaInvoiceV2')
    const invoice = await Invoice.deploy(owner.address, await oracle.getAddress())
    const Settlement = await ethers.getContractFactory('FluxaSettlementV2')
    const settlement = await Settlement.deploy(owner.address, await invoice.getAddress(), await oracle.getAddress())
    await invoice.setAcceptedToken(await fxrp.getAddress(), true)
    await invoice.setAcceptedToken(await usdt.getAddress(), true)
    await invoice.setSettlementContract(await settlement.getAddress())
    await oracle.setPrice(await fxrp.getAddress(), 2_500_000, 6, await time.latest())
    await oracle.setPrice(await usdt.getAddress(), 1_000_000, 6, await time.latest())
    await fxrp.mint(customer.address, 1_000_000_000)
    await usdt.mint(customer.address, 1_000_000_000)
    await fxrp.connect(customer).approve(await invoice.getAddress(), ethers.MaxUint256)
    await usdt.connect(customer).approve(await invoice.getAddress(), ethers.MaxUint256)
    return { owner, merchant, customer, fxrp, usdt, invoice, settlement }
  }

  async function create(base: Awaited<ReturnType<typeof fixture>>, settlementToken: string) {
    const due = (await time.latest()) + 3600
    await base.invoice.connect(base.merchant).createInvoice(
      [await base.fxrp.getAddress(), await base.usdt.getAddress()],
      settlementToken, 500_000_000, due, ethers.id(`invoice-${due}`),
    )
  }

  it('lets the customer choose either accepted token', async () => {
    const base = await fixture(); await create(base, await base.usdt.getAddress())
    expect(await base.invoice.quotePaymentAmount(1, await base.fxrp.getAddress())).to.equal(200_000_000)
    expect(await base.invoice.quotePaymentAmount(1, await base.usdt.getAddress())).to.equal(500_000_000)
    await base.usdt.mint(base.owner.address, 500_000_000)
    await base.usdt.approve(await base.settlement.getAddress(), 500_000_000)
    await base.settlement.fundReserve(await base.usdt.getAddress(), 500_000_000)
    await expect(base.invoice.connect(base.customer).payInvoice(1, await base.fxrp.getAddress(), 200_000_000))
      .to.emit(base.invoice, 'InvoicePaid').withArgs(1, base.customer.address, await base.fxrp.getAddress(), 200_000_000, 0)
  })

  it('rejects a token not configured on the invoice', async () => {
    const base = await fixture(); await create(base, await base.usdt.getAddress())
    await expect(base.invoice.connect(base.customer).payInvoice(1, ethers.ZeroAddress, 500_000_000))
      .to.be.revertedWithCustomError(base.invoice, 'UnsupportedPaymentToken')
  })

  it('enforces the payer maximum when the live quote moves', async () => {
    const base = await fixture(); await create(base, await base.usdt.getAddress())
    await expect(base.invoice.connect(base.customer).payInvoice(1, await base.fxrp.getAddress(), 199_999_999))
      .to.be.revertedWithCustomError(base.invoice, 'QuoteExceeded')
      .withArgs(200_000_000, 199_999_999)
  })

  it('settles same-asset payment directly to the merchant', async () => {
    const base = await fixture(); await create(base, await base.usdt.getAddress())
    await base.invoice.connect(base.customer).payInvoice(1, await base.usdt.getAddress(), 500_000_000)
    await expect(() => base.settlement.settleInvoice(1)).to.changeTokenBalance(base.usdt, base.merchant, 500_000_000)
  })

  it('atomically rejects cross-asset payment until the reserve is funded', async () => {
    const base = await fixture(); await create(base, await base.usdt.getAddress())
    await expect(base.invoice.connect(base.customer).payInvoice(1, await base.fxrp.getAddress(), 200_000_000))
      .to.be.revertedWithCustomError(base.settlement, 'InsufficientReserve')
    expect((await base.invoice.getInvoice(1)).status).to.equal(0)
    expect(await base.fxrp.balanceOf(await base.invoice.getAddress())).to.equal(0)
    await base.usdt.mint(base.owner.address, 500_000_000)
    await base.usdt.approve(await base.settlement.getAddress(), 500_000_000)
    await base.settlement.fundReserve(await base.usdt.getAddress(), 500_000_000)
    await base.invoice.connect(base.customer).payInvoice(1, await base.fxrp.getAddress(), 200_000_000)
    expect(await base.settlement.reservedAmount(1)).to.equal(500_000_000)
    await expect(() => base.settlement.settleInvoice(1)).to.changeTokenBalance(base.usdt, base.merchant, 500_000_000)
  })

  it('reports cross-asset capacity and protects liquidity already reserved', async () => {
    const base = await fixture(); await create(base, await base.usdt.getAddress())
    const fxrpAddress = await base.fxrp.getAddress()
    const usdtAddress = await base.usdt.getAddress()

    expect(await base.settlement.capacityFor(1, fxrpAddress)).to.deep.equal([
      500_000_000n, 0n, false,
    ])

    await base.usdt.mint(base.owner.address, 600_000_000)
    await base.usdt.approve(await base.settlement.getAddress(), 600_000_000)
    await base.settlement.fundReserve(usdtAddress, 600_000_000)
    expect(await base.settlement.capacityFor(1, fxrpAddress)).to.deep.equal([
      500_000_000n, 600_000_000n, true,
    ])

    await base.invoice.connect(base.customer).payInvoice(1, fxrpAddress, 200_000_000)
    await expect(base.settlement.withdrawReserve(usdtAddress, base.owner.address, 100_000_001))
      .to.be.revertedWithCustomError(base.settlement, 'InsufficientReserve')
      .withArgs(usdtAddress, 100_000_001, 100_000_000)
  })

  it('cannot be paid twice', async () => {
    const base = await fixture(); await create(base, await base.usdt.getAddress())
    await base.invoice.connect(base.customer).payInvoice(1, await base.usdt.getAddress(), 500_000_000)
    await expect(base.invoice.connect(base.customer).payInvoice(1, await base.usdt.getAddress(), 500_000_000))
      .to.be.revertedWithCustomError(base.invoice, 'InvalidStatus')
  })
})
