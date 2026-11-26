package com.focusguard.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

private val day = lightColorScheme(
    primary = Color(0xff245451), onPrimary = Color.White,
    primaryContainer = Color(0xffC5E8DE), onPrimaryContainer = Color(0xff102E26),
    secondary = Color(0xff47635B), secondaryContainer = Color(0xffDFEBF4), onSecondaryContainer = Color(0xff18392E),
    tertiary = Color(0xff3D596F), background = Color(0xffEEF2F2), onBackground = Color(0xff152720),
    surface = Color(0xffFCFEFD), onSurface = Color(0xff152720), surfaceVariant = Color(0xffDFEAE4),
    onSurfaceVariant = Color(0xff435951), outline = Color(0xff6C8178),
)
private val night = darkColorScheme(
    primary = Color(0xff8BD5C6), onPrimary = Color(0xff07372A),
    primaryContainer = Color(0xff214842), onPrimaryContainer = Color(0xffC5E8DE),
    secondary = Color(0xffA8CCBC), secondaryContainer = Color(0xff253B4B), onSecondaryContainer = Color(0xffDFEBF4),
    tertiary = Color(0xffA6CAE3), background = Color(0xff101A1D), onBackground = Color(0xffE1F0E8),
    surface = Color(0xff172528), onSurface = Color(0xffE1F0E8), surfaceVariant = Color(0xff2C443A),
    onSurfaceVariant = Color(0xffC0CEC6), outline = Color(0xff889D93),
)
private val rounded = Shapes(
    extraSmall = RoundedCornerShape(8.dp), small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(18.dp), large = RoundedCornerShape(24.dp), extraLarge = RoundedCornerShape(32.dp),
)

@Composable
fun FocusGuardTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) night else day, shapes = rounded, content = content)
}
