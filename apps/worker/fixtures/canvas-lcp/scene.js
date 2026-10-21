const c = document.getElementById('scene')
const g = c.getContext('2d')
g.fillStyle = '#0b3d91'
g.fillRect(0, 0, c.width, c.height)
g.fillStyle = '#fff'
g.beginPath()
g.arc(c.width / 2, c.height / 2, 200, 0, Math.PI * 2)
g.fill()
