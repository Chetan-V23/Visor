import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { diagramFixtureSchema } from '@visor/protocol'

const root = resolve(import.meta.dirname, '../../..')
const sample = diagramFixtureSchema.parse(JSON.parse(await readFile(resolve(root, 'apps/desktop/src/renderer/fixtures/sample-diagram.json'), 'utf8')))
const removed = sample.changes.flatMap((change) => change.delta).find((delta) => delta.op === 'member.remove' && delta.member.name === 'checkout')
const total = sample.changes.flatMap((change) => change.delta).find((delta) => delta.op === 'member.change' && delta.after.name === 'total')
const changes = [...sample.changes].sort((first, second) => first.seq - second.seq).map((original) => {
  const change = structuredClone(original)
  const model = structuredClone(sample.model)
  if (change.seq < 4) {
    model.classes = model.classes.filter((symbol) => symbol.name !== 'CheckoutService')
    model.relations = []
    const cart = model.classes.find((symbol) => symbol.name === 'Cart')
    if (cart && removed?.op === 'member.remove' && removed.member.kind === 'method') {
      cart.methods = cart.methods.filter((method) => method.name !== 'add_item')
      cart.methods.push(structuredClone(removed.member))
      if (change.seq === 1 && total?.op === 'member.change' && total.before.kind === 'method') {
        const previousMethod = total.before
        cart.methods = cart.methods.map((method) => method.name === 'total' ? structuredClone(previousMethod) : method)
      }
    }
    const invoice = model.classes.find((symbol) => symbol.name === 'Invoice')
    if (invoice && change.seq < 3) invoice.methods = invoice.methods.filter((method) => method.name !== 'save')
    if (change.seq === 1) change.delta = model.classes.map((node) => ({ v: 1, op: 'node.add', node }))
  }
  return { change, model }
})
const folder = resolve(root, 'fixtures/sessions/four-changes')
await mkdir(folder, { recursive: true })
await writeFile(resolve(folder, 'history.json'), `${JSON.stringify({ v: 1, session: sample.session, changes }, null, 2)}\n`)
process.stdout.write('Generated the illustrative four-change stored-history fixture.\n')