package com.muhannadsatlink.wasl.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

val Cyan = Color(0xFF22D3EE)
val Violet = Color(0xFF7C5CFF)
val Pink = Color(0xFFFF5CA8)
val Ok = Color(0xFF34D399)
val Warn = Color(0xFFFBBF24)

val BrandGradient = Brush.linearGradient(listOf(Cyan, Violet, Pink))

private val Dark = darkColorScheme(
    primary = Violet,
    onPrimary = Color.White,
    secondary = Cyan,
    tertiary = Pink,
    background = Color(0xFF0B0E1A),
    onBackground = Color(0xFFEEF0FF),
    surface = Color(0xFF141830),
    onSurface = Color(0xFFEEF0FF),
    surfaceVariant = Color(0xFF1B2040),
    onSurfaceVariant = Color(0xFF9AA0C3),
    outline = Color(0x33FFFFFF),
)

private val Light = lightColorScheme(
    primary = Color(0xFF6D4CF0),
    onPrimary = Color.White,
    secondary = Color(0xFF0891B2),
    tertiary = Color(0xFFDB2777),
    background = Color(0xFFF4F5FB),
    onBackground = Color(0xFF171A33),
    surface = Color.White,
    onSurface = Color(0xFF171A33),
    surfaceVariant = Color(0xFFECEEF8),
    onSurfaceVariant = Color(0xFF646A8C),
    outline = Color(0x1F14183C),
)

@Composable
fun WaslTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
