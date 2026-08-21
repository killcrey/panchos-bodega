// Client-side cart, persisted in localStorage so it survives a reload.
// Free ($0) items never go through here — they stay on the existing
// email-capture download flow, which has nothing to do with Stripe checkout.
const CART_STORAGE_KEY = 'bodegaCart'

function cartKey(productId, size) {
  return `${productId}|${size || ''}`
}

export function getCart() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch (_err) {
    return []
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart))
  window.dispatchEvent(new CustomEvent('cart:updated', { detail: { cart } }))
}

// product: a row from the `products` table. size is required when the
// product has sizes. Quantity is capped at the product's tracked inventory,
// if any.
export function addToCart(product, { size = null, quantity = 1 } = {}) {
  const cart = getCart()
  const key = cartKey(product.id, size)
  const existing = cart.find(item => item.key === key)
  const cap = product.inventory_count != null ? product.inventory_count : Infinity

  if (existing) {
    existing.quantity = Math.min(existing.quantity + quantity, cap)
  } else {
    cart.push({
      key,
      productId: product.id,
      title: product.title,
      priceCents: product.price_cents,
      category: product.category || null,
      size,
      quantity: Math.min(quantity, cap),
      weightOz: product.weight_oz != null ? product.weight_oz : null,
      inventoryCount: product.inventory_count != null ? product.inventory_count : null,
      imageUrl: product.cover_art_url || null,
    })
  }

  saveCart(cart)
  return cart
}

export function removeFromCart(key) {
  const cart = getCart().filter(item => item.key !== key)
  saveCart(cart)
  return cart
}

export function setCartQuantity(key, quantity) {
  const cart = getCart()
  const item = cart.find(i => i.key === key)
  if (!item) return cart

  const cap = item.inventoryCount != null ? item.inventoryCount : Infinity
  const clamped = Math.min(Math.max(1, quantity), cap)

  if (quantity <= 0) {
    return removeFromCart(key)
  }

  item.quantity = clamped
  saveCart(cart)
  return cart
}

export function clearCart() {
  saveCart([])
}

export function cartCount(cart = getCart()) {
  return cart.reduce((sum, item) => sum + item.quantity, 0)
}

export function cartSubtotalCents(cart = getCart()) {
  return cart.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
}

// A cart item ships if it has a package weight set, regardless of category —
// apparel, art, music, and pancho picks can each be physical or digital depending
// on the individual item.
export function cartHasPhysicalItems(cart = getCart()) {
  return cart.some(item => item.weightOz != null && item.weightOz > 0)
}
