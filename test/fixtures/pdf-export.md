# PDF Export Fixture

This fixture checks rendered text, a relative image, tables, code, links, and
inline equations.

![Markwise icon](../../app/icon.svg)

| Feature | Expected output |
|---|---|
| Relative image | Visible icon |
| Link | [Milkdown](https://milkdown.dev) |
| Equation | $E = mc^2$ |

```javascript
function aVeryLongFunctionNameThatMustWrapWithoutClipping(value) {
  return `The exported value is ${value}`
}
```

## Second section

- [x] Completed item
- [ ] Incomplete item

The PDF should contain selectable text and a print-friendly light background.
