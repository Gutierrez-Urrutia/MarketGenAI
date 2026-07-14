from pydantic import BaseModel, EmailStr, Field

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8)
    name: str = Field(..., min_length=2, max_length=120)

class LoginRequest(BaseModel):
    usernameOrEmail: EmailStr
    password: str = Field(..., min_length=1)

class UserInfo(BaseModel):
    id: str
    email: str
    name: str
    role: str
    roles: list[str] = ["user"]

class LoginResponse(BaseModel):
    accessToken: str
    refreshToken: str
    expiresIn: int
    user: UserInfo

class LogoutRequest(BaseModel):
    refreshToken: str

class RefreshRequest(BaseModel):
    refreshToken: str

class RefreshResponse(BaseModel):
    accessToken: str
    expiresIn: int
    refreshToken: str | None = None

class ForgotPasswordRequest(BaseModel):
    email: EmailStr

class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(..., min_length=8)

class MessageResponse(BaseModel):
    message: str
